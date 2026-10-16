import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { boundPath, filePath, guardRuntimePaths } from '../src/paths.js';
import { coreArguments } from '../src/policy.js';

const roots: string[] = [];
function fixture(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-native-path-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive:true, force:true});
});

describe('native project paths', () => {
  it('guards native absolute metadata paths and portable transport paths identically', () => {
    const root = fixture();
    const directory = path.join(root, 'artifacts/runs/run/computation');
    fs.mkdirSync(path.join(root, '.nullius'), {recursive:true});
    fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({run_id:'run'}));
    expect(() => guardRuntimePaths(root, path.join(directory, 'manifest.json'))).not.toThrow();
    expect(boundPath(root, 'artifacts/runs/run/computation/manifest.json')).toBe(path.join(directory, 'manifest.json'));
    expect(boundPath(root, path.join(directory, 'manifest.json'))).toBe(path.join(directory, 'manifest.json'));
    expect(coreArguments(root, 'orch_run_status', {project_root:root}).project_root).toBe(root);
  });

  it('rejects escapes and protected files in native and slash spellings', () => {
    const root = fixture();
    for (const value of ['../escape', 'inputs/../escape', 'inputs\\escape', path.join(path.dirname(root), 'escape')]) {
      expect(() => boundPath(root, value), value).toThrow();
    }
    expect(() => filePath(root, 'AGENTS.md', true)).toThrow();
    if (process.platform === 'win32') {
      for (const value of ['AGENTS.md.', 'AGENTS.md ', 'inputs/note:secret', 'inputs/CON.txt', `${root}\\inputs\\..\\escape`]) {
        expect(() => filePath(root, value, true), value).toThrow();
      }
      expect(filePath(root, path.join(root, 'inputs', '方法.txt'), true)).toBe(path.join(root, 'inputs', '方法.txt'));
    }
  });

  it('refuses directory junctions and symlinks below the root without following them', () => {
    const root = fixture();
    const outside = fixture();
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => boundPath(root, 'linked/input.txt')).toThrow();
    fs.mkdirSync(path.join(root, '.nullius'), {recursive:true});
    fs.symlinkSync(outside, path.join(root, '.nullius', 'substituted'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => guardRuntimePaths(root)).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('checks referenced historical evidence using native directory access', () => {
    const root = fixture();
    const outside = fixture();
    fs.mkdirSync(path.join(root, '.nullius'));
    fs.mkdirSync(path.join(root, 'team/runs/past/data'), {recursive:true});
    fs.symlinkSync(outside, path.join(root, 'team/runs/past/data/external'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(path.join(root, '.nullius/state.json'), JSON.stringify({
      run_id:'past', artifacts:{x:'orch://runs/past/artifact/data/external/value.json'},
    }));
    expect(() => guardRuntimePaths(root)).toThrow();
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
