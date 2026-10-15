/**
 * The harness-invocation verifier (shared) skips the home directory on the
 * strength of one invariant: the CLI's lifecycle project-root search never
 * admits the home directory as a project root. This test couples the two
 * behaviours on the same home directory so that neither can drift alone.
 *
 * The home directory here deliberately looks like a project (state.json,
 * ledger.jsonl, AGENTS.md): the skip is a decision about the home directory,
 * not an accident of missing files. A project nested below the home directory
 * is found by the CLI and verified by the shared verifier.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mocked.home };
});

import { findLifecycleProjectRoot } from '../src/cli-project-root.js';
import { McpError, verifyHarnessInvocationMarker } from '@nullius/shared';

const FORCE_ON_ENV = { NULLIUS_HARNESS_VERIFY: 'on' } as NodeJS.ProcessEnv;

function expectHarnessRefusal(run: () => void): void {
  let thrown: unknown;
  try { run(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(McpError);
  expect((thrown as McpError).code).toBe('HARNESS_INVOCATION_REQUIRED');
}

function writeProjectLikeFiles(root: string): void {
  fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
  fs.writeFileSync(path.join(root, '.nullius', 'state.json'), '{}\n');
  fs.writeFileSync(path.join(root, '.nullius', 'ledger.jsonl'), '');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), '# project\n');
}

describe('the home directory is never a lifecycle project root', () => {
  let home: string;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home-never-root-')));
    mocked.home = home;
    writeProjectLikeFiles(home);
    writeProjectLikeFiles(path.join(home, 'project'));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('CLI search: a project-like home directory is skipped, a project below it is found', () => {
    expect(findLifecycleProjectRoot(home)).toBeNull();
    expect(findLifecycleProjectRoot(path.join(home, 'project'))).toBe(path.join(home, 'project'));
    expect(findLifecycleProjectRoot(path.join(home, 'project', 'sub'))).toBe(path.join(home, 'project'));
  });

  it('shared verifier: the same home directory is skipped, the project below it is verified', () => {
    expect(() => verifyHarnessInvocationMarker(home, { env: FORCE_ON_ENV, homeDir: home })).not.toThrow();
    expectHarnessRefusal(() => verifyHarnessInvocationMarker(path.join(home, 'project'), { env: FORCE_ON_ENV, homeDir: home }));
  });

  it('both recognize the home directory through a symbolic-link alias', () => {
    const alias = `${home}-alias`;
    fs.symlinkSync(home, alias);
    try {
      expect(findLifecycleProjectRoot(alias)).toBeNull();
      expect(findLifecycleProjectRoot(path.join(alias, 'project'))).toBe(path.join(alias, 'project'));
      expect(() => verifyHarnessInvocationMarker(alias, { env: FORCE_ON_ENV, homeDir: home })).not.toThrow();
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it('control: the same directory counts as a project root once it is not the home directory', () => {
    mocked.home = path.join(home, 'elsewhere');
    expect(findLifecycleProjectRoot(home)).toBe(home);
    expectHarnessRefusal(() => verifyHarnessInvocationMarker(home, { env: FORCE_ON_ENV, homeDir: mocked.home }));
  });
});
