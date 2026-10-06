import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRunDirectories, readRunDirFor } from '../src/run-directories.js';
import { buildTraceabilityView } from '../src/traceability-view.js';
import { computeRunIndexProjection, renderRunIndexBlock } from '../src/run-index.js';
import { runInitCommand } from '../src/cli-init.js';
import { stampRunDirectory, gradeExistingStamp } from '../src/run-stamp.js';
import { handleOrchRunCreate, handleOrchRunStatus, handleOrchRunList } from '../src/orch-tools/create-status-list.js';
import { handleOrchRunExport } from '../src/orch-tools/control.js';
import { OrchRunListSchema, OrchRunExportSchema } from '../src/orch-tools/schemas.js';
import { setCurrentResult, validateResultRegistry } from '../src/result-registry.js';
import { backfillRunOrigins } from '../src/trace-backfill.js';
import { StateManager } from '../src/state-manager.js';
import { executeComputationManifest, stageContentInRunDir } from '../src/computation/index.js';
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

describe('canonical writes and historical evidence reads', () => {
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
  it('lists and exports historical files at their original location without modifying evidence', async () => {
    const old = path.join(root, 'team/runs/past');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, 'report.md'), 'prior report');
    const before = snapshot(old);
    await expect(runExportCommand(root, root, ['--run-id', 'past', '--out', path.join(old, 'report.md')], { cwd: root, stdout: () => {}, stderr: () => {} })).rejects.toThrow('HISTORICAL_RUN_READ_ONLY');
    expect(snapshot(old)).toEqual(before);
    const listed = await handleOrchRunList(OrchRunListSchema.parse({ project_root: root, limit: 20 })) as any;
    expect(listed.runs).toContainEqual(expect.objectContaining({ run_id: 'past', relative_path: 'team/runs/past', last_status: 'unknown', historical_read_only: true }));
    const summary = await handleOrchRunExport(OrchRunExportSchema.parse({ project_root: root, _confirm: true })) as any;
    expect(summary.exported).toBe(true);
    expect(summary.project_recent_digest.reliable).toBe(false);
    expect(summary.project_recent_digest.ledger_available).toBe(false);
    expect(summary.artifact_runs[0].files).toContain('team/runs/past/report.md');
    await runExportCommand(root, root, ['--run-id', 'past'], { cwd: root, stdout: () => {}, stderr: () => {} });
    expect(execFileSync('unzip', ['-Z1', path.join(root, 'exports/past.zip')], { encoding: 'utf8' })).toBe('team/runs/past/report.md\n');
    expect(snapshot(old)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'artifacts/runs/past'))).toBe(false);
  });

  it('preserves stamped historical current results, validity and original links', () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q'); git('config', 'user.name', 'fixture'); git('config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, '.gitignore'), 'artifacts/\nteam/\n.nullius/\n');
    fs.writeFileSync(path.join(root, 'source.txt'), 'source');
    fs.writeFileSync(path.join(root, 'project_index.md'), '# Project\n\n<!-- RESULT_REGISTRY_START -->\n| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |\n|---|---|---|---|---|---|\n<!-- RESULT_REGISTRY_END -->\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    const canonical = path.join(root, 'artifacts/runs/past');
    fs.mkdirSync(canonical, { recursive: true });
    expect(stampRunDirectory(root, 'artifacts/runs/past', { actor: 'fixture' }).kind).toBe('stamped');
    fs.mkdirSync(path.join(root, 'team/runs'), { recursive: true });
    fs.renameSync(canonical, path.join(root, 'team/runs/past'));
    fs.writeFileSync(path.join(root, 'team/runs/past/result.txt'), 'original result');
    setCurrentResult(root, { resultId: 'selected', runId: 'past', artifactRelPath: 'team/runs/past/result.txt' });
    const before = snapshot(root);
    const view = buildTraceabilityView(root);
    expect(view.runs.counts.active).toBe(1);
    expect(view.runs.stamped).toBe(1);
    expect(view.warnings.mirror_divergence).toEqual([]);
    expect(validateResultRegistry(root).defective_result_ids.size).toBe(0);
    expect(renderRunIndexBlock(computeRunIndexProjection(root))).toContain('(team/runs/past/)');
    expect(snapshot(root)).toEqual(before);
    backfillRunOrigins(root);
    expect(snapshot(root)).toEqual(before);
  });

  it('reports duplicate identities, supports explicit read/export roots and rejects writes before mutation', async () => {
    for (const folder of ['artifacts/runs/shared', 'team/runs/shared', 'artifacts/runs/other']) fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, 'team/runs/shared/report.md'), 'old');
    fs.writeFileSync(path.join(root, 'artifacts/runs/shared/report.md'), 'current');
    expect(listRunDirectories(root).filter(run => run.run_id === 'shared').every(run => run.ambiguous)).toBe(true);
    expect(() => readRunDirFor(root, 'shared')).toThrow('RUN_ID_AMBIGUOUS');
    expect(readRunDirFor(root, 'other')).toBe(path.join(root, 'artifacts/runs/other'));
    expect(buildTraceabilityView(root).runs.directory_issues?.some(issue => issue.code === 'RUN_ID_AMBIGUOUS')).toBe(true);
    const before = snapshot(root);
    await expect(runExportCommand(root, root, ['--run-id', 'shared'], { cwd: root, stdout: () => {}, stderr: () => {} })).rejects.toThrow('RUN_ID_AMBIGUOUS');
    await expect(handleOrchRunCreate({ project_root: root, run_id: 'shared' })).rejects.toThrow('HISTORICAL_RUN_READ_ONLY');
    expect(stampRunDirectory(root, 'artifacts/runs/shared', { actor: 'fixture' }).kind).toBe('rejected');
    expect(snapshot(root)).toEqual(before);
    await runExportCommand(root, root, ['--run-id', 'shared', '--run-root', 'team/runs'], { cwd: root, stdout: () => {}, stderr: () => {} });
    expect(execFileSync('unzip', ['-p', path.join(root, 'exports/shared.zip'), 'team/runs/shared/report.md'], { encoding: 'utf8' })).toBe('old');
  });

  it('scopes unavailable history and reservations to the affected read', async () => {
    fs.mkdirSync(path.join(root, 'team/runs/shared'), { recursive: true });
    fs.mkdirSync(path.join(root, 'artifacts/runs/shared'), { recursive: true });
    fs.mkdirSync(path.join(root, 'artifacts/runs/other'), { recursive: true });
    fs.chmodSync(path.join(root, 'team/runs/shared'), 0);
    try {
      expect(() => readRunDirFor(root, 'shared')).toThrow('RUN_ID_AMBIGUOUS');
      expect(readRunDirFor(root, 'other')).toBe(path.join(root, 'artifacts/runs/other'));
      expect(buildTraceabilityView(root).runs.directory_issues?.some(issue => issue.code === 'RUN_DIRECTORY_UNREADABLE')).toBe(true);
    } finally { fs.chmodSync(path.join(root, 'team/runs/shared'), 0o755); }
    await handleOrchRunCreate({ project_root: root, run_id: 'other' });
    fs.chmodSync(path.join(root, 'team/runs'), 0);
    try {
      expect(buildTraceabilityView(root).runs.total_directories).toBe(2);
      expect(buildTraceabilityView(root).runs.directory_issues?.[0]?.code).toBe('HISTORICAL_RUN_ROOT_UNREADABLE');
      await expect(handleOrchRunStatus({ project_root: root })).resolves.toMatchObject({ run_id: 'other' });
    } finally { fs.chmodSync(path.join(root, 'team/runs'), 0o755); }
  });

  it('rejects historical staging, execution and resume while reconnecting runtime in place', async () => {
    const old = path.join(root, 'team/runs/past');
    fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'report.md'), 'evidence');
    const before = snapshot(old);
    expect(() => stageContentInRunDir({ runId: 'fresh', runDir: path.join(root, 'TEAM/RUNS/fresh'), contentType: 'section_output', content: 'overwrite' })).toThrow('HISTORICAL_RUN_READ_ONLY');
    for (const runDir of [path.join(root, 'ARTIFACTS/RUNS/past'), path.join(root, 'artifacts/runs/past/nested')]) {
      expect(() => stageContentInRunDir({ runId: 'fresh', runDir, contentType: 'section_output', content: 'overwrite' })).toThrow('HISTORICAL_RUN_READ_ONLY');
    }
    fs.mkdirSync(path.join(root, 'artifacts/runs'), { recursive: true });
    fs.symlinkSync(path.join(root, 'artifacts/runs'), path.join(root, 'run-alias'));
    expect(() => stageContentInRunDir({ runId: 'fresh', runDir: path.join(root, 'run-alias/past'), contentType: 'section_output', content: 'overwrite' })).toThrow('HISTORICAL_RUN_READ_ONLY');
    expect(() => stageContentInRunDir({ runId: 'past', runDir: old, contentType: 'section_output', content: 'overwrite' })).toThrow('HISTORICAL_RUN_READ_ONLY');
    await expect(executeComputationManifest({ projectRoot: root, runId: 'past', runDir: old, manifestPath: path.join(old, 'manifest.json'), dryRun: true })).rejects.toThrow('HISTORICAL_RUN_READ_ONLY');
    await runInitCommand(root, root, ['--runtime-only', '--no-git'], { cwd: root, stdout: () => {}, stderr: () => {} });
    expect(fs.existsSync(path.join(root, '.nullius/HARNESS'))).toBe(true);
    const manager = new StateManager(root); const state = manager.readState(); state.run_id = 'past'; state.run_status = 'paused';
    expect(() => manager.resumeRun(state, { force: true })).toThrow('HISTORICAL_RUN_READ_ONLY');
    expect(() => manager.pauseRun(state)).toThrow('HISTORICAL_RUN_READ_ONLY');
    expect(snapshot(old)).toEqual(before);
    expect(fs.existsSync(path.join(root, 'artifacts/runs/past'))).toBe(false);
  });
});
