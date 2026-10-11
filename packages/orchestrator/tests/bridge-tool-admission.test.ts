import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sanitizeRelativePath } from '../src/computation/path-safety.js';
import { handleToolCall } from '../src/tooling.js';

/** The computation bridge tools admit project_root as every other front door
 *  does, and write a method's files only into the run directory. Each project
 *  here is reached through an explicit symlink, so the checks discriminate on
 *  every platform, not only where the temp directory itself is an alias. */

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true });
});

function tempParent(): string {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-bridge-admission-')));
  parents.push(parent);
  return parent;
}

/** `root` is the canonical project directory; `alias` is a symlink to it. */
function aliasedProject(): { parent: string; root: string; alias: string } {
  const parent = tempParent();
  const root = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  fs.mkdirSync(root);
  fs.symlinkSync(root, alias, 'dir');
  return { parent, root, alias };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; payload: Record<string, any> }> {
  const result = await handleToolCall(name, args, 'full');
  return { isError: result.isError === true, payload: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

const WRITE_VALUE = "from pathlib import Path\nPath('outputs').mkdir(exist_ok=True)\nPath('outputs/value.txt').write_text('5\\n')\n";

function handoff(files: Array<{ path: string; content: string }>, script: string, outputs: string[]): Record<string, unknown> {
  return {
    campaign_id: 'cccccc01', node_id: 'nnnnnn02', idea_id: 'dddddd03', promoted_at: '2026-03-13T00:00:00Z',
    grounding_audit: { status: 'pass', folklore_risk_score: 0.1, failures: [], timestamp: '2026-03-13T00:00:00Z' },
    idea_card: {
      thesis_statement: 'Evaluate a supplied operation.',
      claims: [{ claim_text: 'The operation has a declared output.' }, { claim_text: 'The input is supplied explicitly.' }],
      testable_hypotheses: ['The declared sum equals five.'],
      required_observables: ['sum'],
      minimal_compute_plan: [{ step: 'Evaluate the sum', method: 'Python', estimated_difficulty: 'low' }],
      method_spec: {
        files,
        run_card: {
          schema_version: 2, workflow_id: 'computation', title: 'Evaluate a supplied operation',
          phases: [{ phase_id: 'task_001', backend: { kind: 'shell', argv: ['python3', script], cwd: '.', timeout_seconds: 10 }, outputs }],
        },
      },
    },
  };
}

/** A run directory under the project's run root, spelled through the alias, with `idea` staged into it. */
async function stagedRun(project: { parent: string; alias: string }, runId: string, idea: Record<string, unknown>): Promise<string> {
  const runDir = path.join(project.alias, 'artifacts', 'runs', runId);
  const handoffPath = path.join(project.parent, `${runId}-handoff.json`);
  writeJson(handoffPath, idea);
  const staged = await call('orch_run_stage_idea', { run_id: runId, run_dir: runDir, handoff_path: handoffPath });
  expect(staged.isError, JSON.stringify(staged.payload)).toBe(false);
  return runDir;
}

describe('computation bridge tools admit project_root like every other front door', () => {
  /** A project root inside a directory laid out as a nullius checkout, named through an alias of that checkout. */
  function projectInsideCheckout(): { project: string; projectRoot: string } {
    const parent = tempParent();
    const checkout = path.join(parent, 'checkout');
    writeJson(path.join(checkout, 'package.json'), { name: 'nullius' });
    fs.writeFileSync(path.join(checkout, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    writeJson(path.join(checkout, 'packages', 'orchestrator', 'package.json'), { name: '@nullius/orchestrator' });
    writeJson(path.join(checkout, 'packages', 'shared', 'package.json'), { name: '@nullius/shared' });
    const project = path.join(checkout, 'proj');
    fs.mkdirSync(project);
    fs.symlinkSync(checkout, path.join(parent, 'alias'), 'dir');
    return { project, projectRoot: path.join(parent, 'alias', 'proj') };
  }

  it.each([
    ['orch_run_plan_computation', { dry_run: true }],
    ['orch_run_execute_manifest', { _confirm: true, manifest_path: 'computation/manifest.json', dry_run: true }],
    ['orch_run_progress_followups', { _confirm: true }],
  ])('%s refuses a project root inside a nullius checkout, named through an alias', async (tool, extra) => {
    const { project, projectRoot } = projectInsideCheckout();
    const result = await call(tool, {
      project_root: projectRoot,
      run_id: 'r1',
      run_dir: path.join(projectRoot, 'artifacts', 'runs', 'r1'),
      ...extra,
    });
    expect(result.isError).toBe(true);
    expect(result.payload.error.message).toMatch(/outside the nullius dev repo/);
    expect(fs.readdirSync(project)).toEqual([]);
  });

  it('plans and validates a run spelled through the alias of an admitted project root', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-alias', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-alias', run_dir: runDir, dry_run: true });
    expect(planned.payload.status, JSON.stringify(planned.payload)).toBe('dry_run');
    const executed = await call('orch_run_execute_manifest', {
      _confirm: true, project_root: project.alias, run_id: 'r-alias', run_dir: runDir, manifest_path: 'computation/manifest.json', dry_run: true,
    });
    expect(executed.payload.status, JSON.stringify(executed.payload)).toBe('dry_run');
  });
});

describe('workspace paths are refused by segment, not by substring', () => {
  it('accepts names that merely contain two dots and refuses every .. segment', () => {
    for (const accepted of ['..data.csv', 'data/..x.csv', 'x..', 'a/b..c/d', '...']) {
      expect(sanitizeRelativePath(accepted, 'p')).toBe(accepted);
    }
    for (const refused of ['..', '../x', 'a/../b', 'a/..', 'a\\..\\b', ' ../x ']) {
      expect(() => sanitizeRelativePath(refused, 'p'), refused).toThrow(/unsafe path traversal/);
    }
    for (const empty of ['', '   ']) {
      expect(() => sanitizeRelativePath(empty, 'p')).toThrow(/cannot be empty/);
    }
    expect(() => sanitizeRelativePath('a\0b', 'p')).toThrow(/unsafe path traversal/);
  });

  it('plans and validates a method whose script and output names begin with two dots', async () => {
    const project = aliasedProject();
    const script = "from pathlib import Path\nPath('outputs').mkdir(exist_ok=True)\nPath('outputs/..value.txt').write_text('5\\n')\n";
    const runDir = await stagedRun(project, 'r-dots', handoff([{ path: 'scripts/..run.py', content: script }], 'scripts/..run.py', ['outputs/..value.txt']));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-dots', run_dir: runDir, dry_run: true });
    expect(planned.payload.status, JSON.stringify(planned.payload)).toBe('dry_run');
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'computation', 'manifest.json'), 'utf-8')) as { steps: Array<{ script: string; expected_outputs: string[] }> };
    expect(manifest.steps[0]).toMatchObject({ script: 'scripts/..run.py', expected_outputs: ['outputs/..value.txt'] });
    expect(fs.readFileSync(path.join(runDir, 'computation', 'scripts', '..run.py'), 'utf-8')).toBe(script);
    const executed = await call('orch_run_execute_manifest', {
      _confirm: true, project_root: project.alias, run_id: 'r-dots', run_dir: runDir, manifest_path: 'computation/manifest.json', dry_run: true,
    });
    expect(executed.payload.status, JSON.stringify(executed.payload)).toBe('dry_run');
  });

  it('still refuses a method file path with a .. segment before writing anything', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-up', handoff([{ path: 'scripts/../../escape.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-up', run_dir: runDir, dry_run: true });
    expect(planned.isError).toBe(true);
    expect(planned.payload.error.message).toMatch(/unsafe path traversal/);
    expect(fs.existsSync(path.join(runDir, 'computation'))).toBe(false);
    expect(fs.existsSync(path.join(runDir, 'escape.py'))).toBe(false);
  });
});

describe('a method is written only into the run directory', () => {
  it('refuses a method file whose directory in the run is a symbolic link, writing nothing through it', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-link', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const outside = path.join(project.parent, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(runDir, 'computation'));
    fs.symlinkSync(outside, path.join(runDir, 'computation', 'scripts'), 'dir');
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-link', run_dir: runDir, dry_run: true });
    expect(planned.isError).toBe(true);
    expect(planned.payload.error.message).toMatch(/must not traverse a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(path.join(runDir, 'computation'))).toEqual(['scripts']);
  });

  it('refuses a computation directory that is a symbolic link even when the method has no files', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-dir', handoff([], 'scripts/run.py', ['outputs/value.txt']));
    const outside = path.join(project.parent, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(runDir, 'computation'), 'dir');
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-dir', run_dir: runDir, dry_run: true });
    expect(planned.isError).toBe(true);
    expect(planned.payload.error.message).toMatch(/must not traverse a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
