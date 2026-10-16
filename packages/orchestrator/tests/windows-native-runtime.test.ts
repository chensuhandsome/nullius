import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nativeExecutableCandidates, pythonExecutable } from '../src/python-runtime.js';
import { resolveCanonicalNativeRuntime, assertNativeRuntimeIdentityLive } from '../src/computation/runtime-identity.js';
import { buildProductionEnvironment } from '../src/computation/dependency-closure.js';

describe.runIf(process.platform === 'win32')('native Windows runtime identity', () => {
  let projectRoot: string;
  let previousPython: string | undefined;
  beforeEach(() => {
    previousPython = process.env.NULLIUS_PYTHON;
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'native-runtime-'));
  });
  afterEach(() => {
    if (previousPython === undefined) delete process.env.NULLIUS_PYTHON;
    else process.env.NULLIUS_PYTHON = previousPython;
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('executes the pinned native runtime with a bounded environment', () => {
    const identity = resolveCanonicalNativeRuntime({ projectRoot, runDir: path.join(projectRoot, 'artifacts/runs/test'), token: 'node' });
    expect(identity.executable_format).toBe('pe');
    expect(identity.canonical_path).toBe(fs.realpathSync.native(process.execPath));
    const environment = buildProductionEnvironment(identity);
    expect(environment.variables.PATH).not.toContain('/usr/bin');
    expect(environment.variables.SystemRoot).toBeTruthy();
    expect(environment.variables.NODE_OPTIONS).toBeUndefined();
    const result = spawnSync(identity.canonical_path, ['-p', '40 + 2'], { env: environment.variables, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('42');
  });

  it('rejects a batch interpreter and a native executable under the research project', () => {
    process.env.NULLIUS_PYTHON = path.join(projectRoot, 'python3.cmd');
    expect(() => pythonExecutable()).toThrow(/native Python/);
    const localExecutable = path.join(projectRoot, 'python.exe');
    fs.copyFileSync(process.execPath, localExecutable);
    process.env.NULLIUS_PYTHON = localExecutable;
    expect(() => resolveCanonicalNativeRuntime({ projectRoot, runDir: path.join(projectRoot, 'artifacts/runs/test'), token: 'python3' }))
      .toThrow(/No canonical native executable/);
  });

  it('cannot override Windows fixed process variables through a declared environment', () => {
    const identity = resolveCanonicalNativeRuntime({ projectRoot, runDir: path.join(projectRoot, 'run'), token: 'node' });
    for (const key of ['SystemRoot', 'WINDIR', 'systemroot', 'PATH', 'NODE_OPTIONS']) {
      expect(() => buildProductionEnvironment(identity, { [key]: 'untrusted' })).toThrow(/fixed safety|not allowlisted/);
    }
  });

  it('refuses stale approved runtime hashes and sizes', () => {
    const runDir = path.join(projectRoot, 'run');
    const identity = resolveCanonicalNativeRuntime({ projectRoot, runDir, token: 'node' });
    for (const changed of [{ ...identity, sha256: '0'.repeat(64) }, { ...identity, size_bytes: identity.size_bytes + 1 }]) {
      expect(() => assertNativeRuntimeIdentityLive({ identity: changed, projectRoot, runDir })).toThrow(/no longer matches/);
    }
  });

  it('resolves versioned bare interpreter tokens to native .exe files', () => {
    expect(nativeExecutableCandidates('python3.11', [projectRoot])).toContain(path.join(projectRoot, 'python3.11.exe'));
    expect(nativeExecutableCandidates('node.exe', [projectRoot])).toEqual([path.join(projectRoot, 'node.exe')]);
  });
});
