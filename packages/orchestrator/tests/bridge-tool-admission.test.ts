import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFollowupRuntimePrompt } from '../src/computation/followup-runtime.js';
import { planComputationFromRunDir } from '../src/computation/index.js';
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
  const staged = await call('orch_run_stage_idea', { project_root: project.alias, run_id: runId, run_dir: runDir, handoff_path: handoffPath });
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
    ['orch_run_stage_idea', { handoff_path: '/nonexistent/handoff.json' }],
    ['orch_run_stage_content', { content_type: 'section_output', content: '{"title":"Draft"}' }],
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

describe('the computation bridge tools work only in a run directory inside the admitted project root', () => {
  /** Arguments that reach each tool's run directory, with `runDir` as given. */
  function argsFor(tool: string, projectRoot: string, runDir: string, handoffPath: string): Record<string, unknown> {
    const base = { project_root: projectRoot, run_id: 'r1', run_dir: runDir };
    switch (tool) {
      case 'orch_run_stage_idea': return { ...base, handoff_path: handoffPath };
      case 'orch_run_stage_content': return { ...base, content_type: 'section_output', content: '{"title":"Draft"}' };
      case 'orch_run_plan_computation': return { ...base, dry_run: true };
      case 'orch_run_execute_manifest': return { ...base, _confirm: true, manifest_path: 'computation/manifest.json', dry_run: true };
      default: return { ...base, _confirm: true };
    }
  }
  const TOOLS = ['orch_run_stage_idea', 'orch_run_stage_content', 'orch_run_plan_computation', 'orch_run_execute_manifest', 'orch_run_progress_followups'];

  function projectWithHandoff(): { parent: string; root: string; alias: string; handoffPath: string } {
    const project = aliasedProject();
    const handoffPath = path.join(project.parent, 'handoff.json');
    writeJson(handoffPath, handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    return { ...project, handoffPath };
  }

  it.each(TOOLS)('%s refuses a run directory outside the project root and writes nothing there', async (tool) => {
    const { parent, alias, handoffPath } = projectWithHandoff();
    const outside = path.join(parent, 'elsewhere', 'r1');
    const result = await call(tool, argsFor(tool, alias, outside, handoffPath));
    expect(result.isError).toBe(true);
    expect(result.payload.error.message).toMatch(/run_dir must stay within/);
    expect(fs.existsSync(path.join(parent, 'elsewhere'))).toBe(false);
  });

  it.each(TOOLS)('%s refuses a run directory inside the project that is not the run\'s own, and writes nothing there', async (tool) => {
    const { root, alias, handoffPath } = projectWithHandoff();
    for (const elsewhere of [path.join('work', 'r1'), path.join('artifacts', 'runs', 'other')]) {
      const result = await call(tool, argsFor(tool, alias, path.join(alias, elsewhere), handoffPath));
      expect(result.isError, elsewhere).toBe(true);
      expect(result.payload.error.message, elsewhere).toBe('run_dir must be the run\'s own directory, <project_root>/artifacts/runs/<run_id>');
      expect(result.payload.error.data, elsewhere).toMatchObject({ expected_run_dir: path.join(root, 'artifacts', 'runs', 'r1') });
      expect(fs.existsSync(path.join(root, elsewhere)), elsewhere).toBe(false);
    }
  });

  it.each(TOOLS)('%s refuses a run directory reached through a symbolic link below the project root', async (tool) => {
    const { parent, root, alias, handoffPath } = projectWithHandoff();
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(root, 'artifacts'));
    fs.symlinkSync(outside, path.join(root, 'artifacts', 'runs'), 'dir');
    const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
    expect(result.isError).toBe(true);
    expect(result.payload.error.message).toMatch(/run_dir must not traverse a symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it.each(TOOLS.flatMap(tool => ['artifacts', 'attempts', 'computation'].map(entry => [tool, entry])))(
    '%s refuses a run directory whose %s/ is a symbolic link, and writes nothing through it',
    async (tool, entry) => {
      const { parent, root, alias, handoffPath } = projectWithHandoff();
      const outside = path.join(parent, 'outside');
      fs.mkdirSync(outside);
      const runDir = path.join(root, 'artifacts', 'runs', 'r1');
      fs.mkdirSync(runDir, { recursive: true });
      fs.symlinkSync(outside, path.join(runDir, entry), 'dir');
      const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.isError).toBe(true);
      expect(result.payload.error.message).toBe(`run_dir/${entry} must not be a symbolic link`);
      expect(fs.readdirSync(outside)).toEqual([]);
    },
  );

  it.each([
    ['approvals', 'dir'], ['approvals/A3-0001', 'dir'], ['computation/logs', 'dir'], ['computation/logs/task_001', 'dir'],
    ['computation/scripts', 'dir'], ['computation/outputs', 'dir'],
    ['computation/execution_status.json', 'file'], ['artifacts/nested/deep.json', 'file'], ['team-execution-state.json', 'file'],
  ])('refuses a run directory with a symbolic link at %s, for every tool, before any work', async (rel, kind) => {
    const { parent, root, alias, handoffPath } = projectWithHandoff();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    const outsideDir = path.join(parent, 'outside');
    const outsideFile = path.join(parent, 'outside.json');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(outsideFile, '{}\n');
    fs.mkdirSync(path.dirname(path.join(runDir, rel)), { recursive: true });
    fs.symlinkSync(kind === 'dir' ? outsideDir : outsideFile, path.join(runDir, rel), kind === 'dir' ? 'dir' : 'file');
    for (const tool of TOOLS) {
      const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.payload.error, tool).toMatchObject({ code: 'UNSAFE_FS', message: `run_dir/${rel} must not be a symbolic link` });
    }
    expect(fs.readdirSync(outsideDir)).toEqual([]);
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('{}\n');
  });

  it('admits a run directory whose method outputs contain a symbolic link, which the manifest checks govern', async () => {
    const { parent, root, alias, handoffPath } = projectWithHandoff();
    const outputs = path.join(root, 'artifacts', 'runs', 'r1', 'computation', 'outputs');
    fs.mkdirSync(outputs, { recursive: true });
    fs.symlinkSync(path.join(parent, 'elsewhere'), path.join(outputs, 'latest'), 'dir');
    const staged = await call('orch_run_stage_content', argsFor('orch_run_stage_content', alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
    expect(staged.isError, JSON.stringify(staged.payload)).toBe(false);
  });

  it.each([
    ['the run directory itself is a file', '', 'run_dir must name a directory'],
    ['artifacts is a file', 'artifacts', 'run_dir/artifacts must be a directory'],
    ['the launch stamp mirror is a directory', 'run_origin.json', 'run_dir/run_origin.json must be a regular file'],
    ['the launch stamp mirror is a FIFO', 'run_origin.json:fifo', 'run_dir/run_origin.json must be a regular file'],
  ])('refuses a run directory where %s, before any write', async (_label, entry, message) => {
    const { root, alias, handoffPath } = projectWithHandoff();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    if (entry === '') {
      fs.mkdirSync(path.dirname(runDir), { recursive: true });
      fs.writeFileSync(runDir, 'x\n');
    } else if (entry === 'run_origin.json') {
      fs.mkdirSync(path.join(runDir, entry), { recursive: true });
    } else if (entry === 'run_origin.json:fifo') {
      fs.mkdirSync(runDir, { recursive: true });
      execFileSync('mkfifo', [path.join(runDir, 'run_origin.json')]);
    } else {
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, entry), 'x\n');
    }
    for (const tool of TOOLS) {
      const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.payload.error, tool).toMatchObject({ code: 'UNSAFE_FS', message });
    }
  });

  it('refuses a run id that a historical run owns as a parameter error, for every tool', async () => {
    const { root, alias, handoffPath } = projectWithHandoff();
    fs.mkdirSync(path.join(root, 'team', 'runs', 'r1'), { recursive: true });
    for (const tool of TOOLS) {
      const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.payload.error, tool).toMatchObject({
        code: 'INVALID_PARAMS', message: expect.stringMatching(/^HISTORICAL_RUN_READ_ONLY/), data: { run_id: 'r1' },
      });
    }
    expect(fs.existsSync(path.join(root, 'artifacts'))).toBe(false);
  });

  it.each([
    ['a file in artifacts/', 'artifacts/computation_result_v1.json', /run_dir\/artifacts\/computation_result_v1\.json must not be a symbolic link/],
    ['an attempt archive', 'attempts/attempt-1', /run_dir\/attempts\/attempt-1 must not be a symbolic link/],
    ['the launch stamp mirror', 'run_origin.json', /run_dir\/run_origin\.json must not be a symbolic link/],
  ])('refuses a run directory where %s is a symbolic link', async (_label, entry, message) => {
    const { parent, root, alias, handoffPath } = projectWithHandoff();
    const outsideFile = path.join(parent, 'outside.json');
    fs.writeFileSync(outsideFile, '{}\n');
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(path.dirname(path.join(runDir, entry)), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(runDir, entry));
    for (const tool of TOOLS) {
      const result = await call(tool, argsFor(tool, alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.isError, tool).toBe(true);
      expect(result.payload.error.message, tool).toMatch(message);
    }
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('{}\n');
  });

  it('refuses a run directory reached through a symbolic link that points back inside the project', async () => {
    const { root, alias, handoffPath } = projectWithHandoff();
    fs.mkdirSync(path.join(root, 'artifacts', 'runs', 'r1link-target'), { recursive: true });
    fs.symlinkSync(path.join(root, 'artifacts', 'runs', 'r1link-target'), path.join(root, 'artifacts', 'runs', 'r1link'), 'dir');
    const result = await call('orch_run_stage_content', {
      ...argsFor('orch_run_stage_content', alias, path.join(alias, 'artifacts', 'runs', 'r1link'), handoffPath), run_id: 'r1link',
    });
    expect(result.payload.error.message).toBe('run_dir must not traverse a symbolic link');
    expect(fs.readdirSync(path.join(root, 'artifacts', 'runs', 'r1link-target'))).toEqual([]);
  });

  it('stages content through the alias into the canonical run directory', async () => {
    const { root, alias, handoffPath } = projectWithHandoff();
    const staged = await call('orch_run_stage_content', argsFor('orch_run_stage_content', alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
    expect(staged.isError, JSON.stringify(staged.payload)).toBe(false);
    expect(fs.readdirSync(path.join(root, 'artifacts', 'runs', 'r1', 'artifacts')).some(name => name.startsWith('staged_section_output'))).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)('reports a run path or historical run that cannot be inspected as an environment failure', async () => {
    const { root, alias, handoffPath } = projectWithHandoff();
    fs.mkdirSync(path.join(root, 'artifacts', 'runs'), { recursive: true });
    fs.chmodSync(path.join(root, 'artifacts'), 0o000);
    try {
      const result = await call('orch_run_stage_content', argsFor('orch_run_stage_content', alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.payload.error).toMatchObject({ code: 'UNSAFE_FS', message: expect.stringMatching(/^cannot inspect /), data: { errno: 'EACCES' } });
    } finally {
      fs.chmodSync(path.join(root, 'artifacts'), 0o755);
    }
    fs.mkdirSync(path.join(root, 'team', 'runs'), { recursive: true });
    fs.chmodSync(path.join(root, 'team', 'runs'), 0o000);
    try {
      const result = await call('orch_run_stage_content', argsFor('orch_run_stage_content', alias, path.join(alias, 'artifacts', 'runs', 'r1'), handoffPath));
      expect(result.payload.error).toMatchObject({ code: 'UNSAFE_FS', message: expect.stringMatching(/^HISTORICAL_RUN_UNAVAILABLE/) });
    } finally {
      fs.chmodSync(path.join(root, 'team', 'runs'), 0o755);
    }
  });

  it('refuses a relative run directory, and a project root that does not exist', async () => {
    const { parent, alias, handoffPath } = projectWithHandoff();
    const relative = await call('orch_run_stage_idea', argsFor('orch_run_stage_idea', alias, path.join('artifacts', 'runs', 'r1'), handoffPath));
    expect(relative.payload.error.message).toMatch(/run_dir must be an absolute path inside project_root/);
    const missingRoot = path.join(parent, 'alias', 'missing');
    const missing = await call('orch_run_stage_idea', argsFor('orch_run_stage_idea', missingRoot, path.join(missingRoot, 'r1'), handoffPath));
    expect(missing.payload.error.message).toMatch(/project_root must name an existing directory/);
    expect(fs.existsSync(path.join(parent, 'real', 'missing'))).toBe(false);
  });

  it('refuses a relative handoff path before staging anything', async () => {
    const { root, alias } = projectWithHandoff();
    const result = await call('orch_run_stage_idea', {
      project_root: alias, run_id: 'r1', run_dir: path.join(alias, 'artifacts', 'runs', 'r1'), handoff_path: 'handoff.json',
    });
    expect(result.payload.error).toMatchObject({ code: 'INVALID_PARAMS', message: 'handoff_path must be an absolute path' });
    expect(fs.existsSync(path.join(root, 'artifacts', 'runs', 'r1', 'artifacts'))).toBe(false);
  });

  it('refuses a run directory that passes through a file, naming it', async () => {
    const { root, alias, handoffPath } = projectWithHandoff();
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x\n');
    const result = await call('orch_run_stage_idea', argsFor('orch_run_stage_idea', alias, path.join(alias, 'notes.txt', 'r1'), handoffPath));
    expect(result.payload.error).toMatchObject({ code: 'UNSAFE_FS', message: 'run_dir passes through something that is not a directory' });
  });

  it('reports a run without a computation result to progress as such, not as a bare system error', async () => {
    const { alias, handoffPath } = projectWithHandoff();
    const runDir = path.join(alias, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    const ctx = { createMessage: async () => { throw new Error('not called'); }, callTool: async () => { throw new Error('not called'); } };
    const result = await handleToolCall('orch_run_progress_followups', argsFor('orch_run_progress_followups', alias, runDir, handoffPath), 'full', ctx as any);
    const payload = JSON.parse(result.content[0]!.text) as { error: { code: string; message: string } };
    expect(payload.error).toMatchObject({ code: 'INVALID_PARAMS', message: 'Failed to load computation_result_v1 from run_dir' });
  });

  it('names the project root and run directory to a delegated follow-up, which must pass them when staging', () => {
    const prompt = buildFollowupRuntimePrompt({
      projectRoot: '/projects/p', runId: 'r1', runDir: '/projects/p/artifacts/runs/r1', taskId: 't1', taskKind: 'draft_update',
      taskTitle: 'Update the draft', computationResultUri: 'rep://runs/r1/artifact/x', handoffId: 'h1', handoffKind: 'writing',
    }).split('\n');
    expect(prompt).toContain('project_root: /projects/p');
    expect(prompt).toContain('run_dir: /projects/p/artifacts/runs/r1');
  });
});

describe('a computation run through an alias of the project root', () => {
  it('stages, plans and executes in the canonical run directory, where its result and launch stamp land', async () => {
    const project = aliasedProject();
    expect((await call('orch_run_create', { project_root: project.alias, run_id: 'r-full', workflow_id: 'computation' })).isError).toBe(false);
    writeJson(path.join(project.root, '.nullius', 'approval_policy.json'), { require_approval_for: { compute_runs: false } });
    const runDir = await stagedRun(project, 'r-full', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-full', run_dir: runDir });
    expect(planned.payload.status, JSON.stringify(planned.payload)).toBe('planned');
    const executed = await call('orch_run_execute_manifest', {
      _confirm: true, project_root: project.alias, run_id: 'r-full', run_dir: runDir, manifest_path: String(planned.payload.manifest_path),
    });
    expect(executed.isError, JSON.stringify(executed.payload)).toBe(false);
    const canonicalRun = path.join(project.root, 'artifacts', 'runs', 'r-full');
    expect(fs.readFileSync(path.join(canonicalRun, 'computation', 'outputs', 'value.txt'), 'utf-8')).toBe('5\n');
    expect(fs.existsSync(path.join(canonicalRun, 'artifacts', 'computation_result_v1.json'))).toBe(true);
    expect(fs.existsSync(path.join(canonicalRun, 'run_origin.json'))).toBe(true);
    // Nothing was written next to the alias.
    expect(fs.readdirSync(project.parent).sort()).toEqual(['alias', 'r-full-handoff.json', 'real']);
  });

  it('requests, accepts and honours an A3 approval for a run reached through the alias', async () => {
    const project = aliasedProject();
    expect((await call('orch_run_create', { project_root: project.alias, run_id: 'r-a3', workflow_id: 'computation' })).isError).toBe(false);
    writeJson(path.join(project.root, '.nullius', 'approval_policy.json'), { require_approval_for: { compute_runs: true } });
    const runDir = await stagedRun(project, 'r-a3', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-a3', run_dir: runDir });
    expect(planned.payload.status, JSON.stringify(planned.payload)).toBe('requires_approval');
    const canonicalRun = path.join(project.root, 'artifacts', 'runs', 'r-a3');
    expect(fs.existsSync(path.join(canonicalRun, 'approvals', String(planned.payload.approval_id)))).toBe(true);
    const approved = await call('orch_run_approve', {
      _confirm: true, project_root: project.alias, approval_id: planned.payload.approval_id,
      approval_packet_sha256: planned.payload.approval_packet_sha256, note: 'Approve the run reached through the alias.',
    });
    expect(approved.isError, JSON.stringify(approved.payload)).toBe(false);
    const executed = await call('orch_run_execute_manifest', {
      _confirm: true, project_root: project.alias, run_id: 'r-a3', run_dir: runDir, manifest_path: String(planned.payload.manifest_path),
    });
    expect(executed.isError, JSON.stringify(executed.payload)).toBe(false);
    expect(fs.readFileSync(path.join(canonicalRun, 'computation', 'outputs', 'value.txt'), 'utf-8')).toBe('5\n');
    expect(fs.existsSync(path.join(canonicalRun, 'run_origin.json'))).toBe(true);
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
  /** Planning called directly, as the command line does, past the bridge tools' admission. */
  async function planDirectly(project: { root: string }, runId: string): Promise<string> {
    try {
      await planComputationFromRunDir({ projectRoot: project.root, runId, runDir: path.join(project.root, 'artifacts', 'runs', runId), dryRun: true });
      return 'planned';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('refuses a method directory in the run that is a symbolic link, at admission and when planning directly', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-link', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const outside = path.join(project.parent, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(runDir, 'computation'));
    fs.symlinkSync(outside, path.join(runDir, 'computation', 'scripts'), 'dir');
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-link', run_dir: runDir, dry_run: true });
    expect(planned.payload.error.message).toBe('run_dir/computation/scripts must not be a symbolic link');
    expect(await planDirectly(project, 'r-link')).toBe('method_spec.files[0].path must not traverse a symbolic link');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.readdirSync(path.join(runDir, 'computation'))).toEqual(['scripts']);
  });

  it('refuses a method file whose own target is a symbolic link, leaving its target untouched', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-leaf', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const outsideFile = path.join(project.parent, 'outside.py');
    fs.writeFileSync(outsideFile, 'original\n');
    fs.mkdirSync(path.join(runDir, 'computation', 'scripts'), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(runDir, 'computation', 'scripts', 'run.py'));
    // The method's workspace files are checked when the manifest is materialized.
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-leaf', run_dir: runDir, dry_run: true });
    expect(planned.payload.error.message).toBe('method_spec.files[0].path must not traverse a symbolic link');
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('original\n');
  });

  it.each(['manifest.json', 'execution_plan_v1.json'])('refuses a planning output whose own target %s is a symbolic link, at admission and when planning directly', async (name) => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-out', handoff([{ path: 'scripts/run.py', content: WRITE_VALUE }], 'scripts/run.py', ['outputs/value.txt']));
    const outsideFile = path.join(project.parent, 'outside.json');
    fs.writeFileSync(outsideFile, '{}\n');
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.symlinkSync(outsideFile, path.join(runDir, 'computation', name));
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-out', run_dir: runDir, dry_run: true });
    expect(planned.payload.error.message).toBe(`run_dir/computation/${name} must not be a symbolic link`);
    expect(await planDirectly(project, 'r-out')).toBe(`computation/${name} must not traverse a symbolic link`);
    expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('{}\n');
    expect(fs.readdirSync(path.join(runDir, 'computation'))).toEqual([name]);
  });

  it('refuses a computation directory that is a symbolic link, also when planning directly a method with no files', async () => {
    const project = aliasedProject();
    const runDir = await stagedRun(project, 'r-dir', handoff([], 'scripts/run.py', ['outputs/value.txt']));
    const outside = path.join(project.parent, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(runDir, 'computation'), 'dir');
    const planned = await call('orch_run_plan_computation', { project_root: project.alias, run_id: 'r-dir', run_dir: runDir, dry_run: true });
    expect(planned.payload.error.message).toBe('run_dir/computation must not be a symbolic link');
    // Planning checks the plan file's path, through computation/, before writing anything.
    expect(await planDirectly(project, 'r-dir')).toBe('computation/execution_plan_v1.json must not traverse a symbolic link');
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});
