import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRunDirectories } from '../src/run-directories.js';
import { buildTraceabilityView } from '../src/traceability-view.js';
import { computeRunIndexProjection } from '../src/run-index.js';
import { runInitCommand } from '../src/cli-init.js';
import { stampRunDirectory, gradeExistingStamp } from '../src/run-stamp.js';
import { handleOrchRunStatus, handleOrchRunList } from '../src/orch-tools/create-status-list.js';
import { runExportCommand } from '../src/cli-export.js';

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-relocation-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function snapshot(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else result[path.relative(directory, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  };
  visit(directory);
  return result;
}

describe('one run root', () => {
  it('grades a generated index refresh as same research code while preserving human and source identity', () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf-8' });
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, '.gitignore'), 'artifacts/\n.nullius/\n');
    fs.writeFileSync(path.join(root, 'source.txt'), 'original source\n');
    const index = '# Project\n\n<!-- RUN_INDEX_START -->\n(Generated run index.)\n<!-- RUN_INDEX_END -->\n\n## Human\noriginal prose\n';
    fs.writeFileSync(path.join(root, 'project_index.md'), index);
    git('add', '.'); git('commit', '-qm', 'fixture');
    fs.mkdirSync(path.join(root, 'artifacts/runs/managed'), { recursive: true });
    const first = stampRunDirectory(root, 'artifacts/runs/managed', { actor: 'fixture' });
    expect(first.kind).toBe('stamped');
    if (first.kind !== 'stamped') throw new Error('stamp failed');
    expect(fs.readFileSync(path.join(root, 'project_index.md'), 'utf8')).not.toBe(index);
    expect(gradeExistingStamp(root, 'managed', first.origin).grade).toBe('same_tree');
    const generated = fs.readFileSync(path.join(root, 'project_index.md'), 'utf8');
    fs.writeFileSync(path.join(root, 'project_index.md'), generated.replace('original prose', 'changed prose'));
    expect(gradeExistingStamp(root, 'managed', first.origin).grade).toBe('different_tree');
    fs.writeFileSync(path.join(root, 'project_index.md'), generated);
    fs.chmodSync(path.join(root, 'project_index.md'), 0o755);
    expect(gradeExistingStamp(root, 'managed', first.origin).grade).toBe('different_tree');
    fs.chmodSync(path.join(root, 'project_index.md'), 0o644);
    fs.writeFileSync(path.join(root, 'project_index.md'), generated.replace('<!-- RUN_INDEX_END -->', ''));
    expect(gradeExistingStamp(root, 'managed', first.origin).grade).toBe('different_tree');
    fs.writeFileSync(path.join(root, 'project_index.md'), generated);
    fs.writeFileSync(path.join(root, 'source.txt'), 'changed source\n');
    expect(gradeExistingStamp(root, 'managed', first.origin).grade).toBe('different_tree');
  });
  it('refuses public export and run list before creating an archive or changing project files', async () => {
    fs.mkdirSync(path.join(root, 'team', 'runs', 'old'), { recursive: true });
    fs.writeFileSync(path.join(root, 'team', 'runs', 'old', 'report.md'), 'prior report');
    const before = snapshot(root);
    await expect(runExportCommand(root, root, ['--run-id', 'old'], { cwd: root, stdout: () => {}, stderr: () => {} })).rejects.toThrow('contains 1 run directories');
    await expect(handleOrchRunList({ project_root: root, limit: 20 })).rejects.toThrow('contains 1 run directories');
    expect(snapshot(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'exports'))).toBe(false);
  });
  it('lists only canonical directories in code point order without mirror fields', () => {
    for (const id of ['z', 'A', 'b']) fs.mkdirSync(path.join(root, 'artifacts', 'runs', id), { recursive: true });
    fs.mkdirSync(path.join(root, 'team', 'runs'), { recursive: true });
    expect(listRunDirectories(root)).toEqual([{ run_id: 'A' }, { run_id: 'b' }, { run_id: 'z' }]);
  });

  it.each([false, true])('refuses unstamped/stamped retired payloads (stamped=%s)', stamped => {
    const old = path.join(root, 'team', 'runs', 'old');
    fs.mkdirSync(old, { recursive: true });
    if (stamped) fs.writeFileSync(path.join(old, 'run_origin.json'), '{"schema_version":1}');
    const before = snapshot(root);
    for (const read of [listRunDirectories, buildTraceabilityView, computeRunIndexProjection]) {
      expect(() => read(root)).toThrow('retired team/runs root contains 1 run directories');
    }
    expect(snapshot(root)).toEqual(before);
  });

  it('does not report an unreadable retired root as clean', () => {
    const old = path.join(root, 'team', 'runs');
    fs.mkdirSync(old, { recursive: true }); fs.chmodSync(old, 0);
    try { expect(() => listRunDirectories(root)).toThrow('retired team/runs root cannot be inspected'); }
    finally { fs.chmodSync(old, 0o755); }
  });

  it('refuses symlinked canonical root and run directories', () => {
    fs.mkdirSync(path.join(root, 'artifacts')); fs.mkdirSync(path.join(root, 'target'));
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'artifacts', 'runs'));
    expect(() => listRunDirectories(root)).toThrow('readable real directory');
    fs.unlinkSync(path.join(root, 'artifacts', 'runs')); fs.mkdirSync(path.join(root, 'artifacts', 'runs'));
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'artifacts', 'runs', 'alias'));
    expect(() => listRunDirectories(root)).toThrow('contains a symlink');
  });

  it('names a retired stamp target explicitly before any provenance mutation', () => {
    fs.mkdirSync(path.join(root, 'team', 'runs', 'old'), { recursive: true });
    const before = snapshot(root);
    const result = stampRunDirectory(root, 'team/runs/old', { actor: 'test' });
    expect(result.kind).toBe('rejected');
    expect(result).toMatchObject({ message: expect.stringContaining('team/runs is a retired run root') });
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses runtime-only reconnect before launcher, sentinel or state changes', async () => {
    fs.mkdirSync(path.join(root, 'team', 'runs', 'old'), { recursive: true });
    fs.mkdirSync(path.join(root, '.nullius', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nullius', 'bin', 'nullius'), 'prior launcher\n');
    fs.writeFileSync(path.join(root, '.nullius', 'HARNESS'), 'prior sentinel\n');
    const before = snapshot(root);
    await expect(runInitCommand(root, root, ['--runtime-only', '--no-git'], { cwd: root, stdout: () => {}, stderr: () => {} })).rejects.toThrow('contains 1 run directories');
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses status before renewing the harness invocation marker', async () => {
    fs.mkdirSync(path.join(root, 'team', 'runs', 'old'), { recursive: true });
    fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
    fs.writeFileSync(path.join(root, '.nullius', 'HARNESS_INVOCATION'), 'prior invocation\n');
    const before = snapshot(root);
    await expect(handleOrchRunStatus({ project_root: root })).rejects.toThrow('contains 1 run directories');
    expect(snapshot(root)).toEqual(before);
  });
});
