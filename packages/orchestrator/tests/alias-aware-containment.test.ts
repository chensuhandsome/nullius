import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { prepareManifest } from '../src/computation/manifest.js';
import { executionBinding } from '../src/computation/execution-binding.js';
import { assertStepPathArgumentsDeclared } from '../src/computation/dependency-closure.js';
import { resolveCanonicalNativeRuntime } from '../src/computation/runtime-identity.js';
import { decisionsLedgerDisplayPath } from '../src/decisions-ledger.js';
import { recordProposalDecision } from '../src/proposal-decisions.js';
import { freezeNotebookReviewScope, reviewerReportRef } from '../src/notebook-content-review.js';
import { handleOrchRunExecuteManifest } from '../src/orch-tools/bridge-tools.js';
import { evaluateReviewFollowupGate } from '../src/computation/review-followup-gate.js';
import { readSkillProposalView } from '../src/orch-tools/skill-proposal.js';
import { resolveEvidencePath } from '../src/run-directories.js';
import { openRetryAttempt, stampRunDirectory } from '../src/run-stamp.js';
import { readValidityLedger } from '../src/validity-ledger.js';
import type { RunState } from '../src/types.js';

/** Every front door admits the project root in canonical, symlink-resolved
 *  form, while callers may spell paths through the alias they used for it.
 *  Each project here is reached through an explicit symlink, so the checks
 *  discriminate on every platform, not only where the temp directory itself
 *  is an alias (macOS /var -> /private/var). */

const parents: string[] = [];
afterEach(() => {
  for (const parent of parents.splice(0)) fs.rmSync(parent, { recursive: true, force: true });
});

/** `root` is the canonical project directory; `alias` is a symlink to it. */
function aliasedProject(): { parent: string; root: string; alias: string; via: (canonical: string) => string } {
  const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-alias-containment-')));
  parents.push(parent);
  const root = path.join(parent, 'real');
  const alias = path.join(parent, 'alias');
  fs.mkdirSync(root);
  fs.symlinkSync(root, alias, 'dir');
  return { parent, root, alias, via: canonical => path.join(alias, path.relative(root, canonical)) };
}

function makeIo(cwd: string) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { cwd, stdout: (text: string) => stdout.push(text), stderr: (text: string) => stderr.push(text) }, stdout, stderr };
}

async function initProject(root: string): Promise<void> {
  expect(await runCli([`--project-root=${root}`, 'init', '--runtime-only', '--no-git'], makeIo(root).io)).toBe(0);
}

const hasZip = spawnSync('zip', ['-v'], { stdio: 'ignore' }).status === 0;

describe('nullius export through an alias of the project root', () => {
  async function projectWithRun() {
    const project = aliasedProject();
    await initProject(project.root);
    const runDir = path.join(project.root, 'artifacts', 'runs', 'r-one');
    fs.mkdirSync(path.join(runDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'result.json'), '{}\n');
    return { ...project, runDir };
  }

  it('refuses an archive written into the evidence directory through the alias', async () => {
    const { alias, runDir, via } = await projectWithRun();
    const out = path.join(via(runDir), 'out.zip');
    await expect(runCli([`--project-root=${alias}`, 'export', '--run-id', 'r-one', '--out', out], makeIo(alias).io))
      .rejects.toThrow(/EXPORT_DESTINATION_OVERLAP/);
    expect(fs.readdirSync(runDir).sort()).toEqual(['result.json', 'sub']);
  });

  it('refuses an archive written into a subdirectory of the evidence directory through a symlink in the project', async () => {
    const { root, runDir } = await projectWithRun();
    fs.mkdirSync(path.join(root, 'exports'));
    fs.symlinkSync(path.join(runDir, 'sub'), path.join(root, 'exports', 'linked'), 'dir');
    await expect(runCli([`--project-root=${root}`, 'export', '--run-id', 'r-one', '--out', path.join(root, 'exports', 'linked', 'out.zip')], makeIo(root).io))
      .rejects.toThrow(/EXPORT_DESTINATION_OVERLAP/);
    expect(fs.readdirSync(path.join(runDir, 'sub'))).toEqual([]);
  });

  it('refuses, with a reason, an archive path whose landing place a dangling symlink leaves undetermined', async () => {
    const { parent, root, alias } = await projectWithRun();
    fs.symlinkSync(path.join(parent, 'not-there'), path.join(root, 'dangling'), 'dir');
    await expect(runCli([`--project-root=${alias}`, 'export', '--run-id', 'r-one', '--out', path.join(alias, 'dangling', 'out.zip')], makeIo(alias).io))
      .rejects.toThrow(/cannot determine where .* lands/);
    expect(fs.existsSync(path.join(parent, 'not-there'))).toBe(false);
  });

  it.skipIf(!hasZip)('writes an archive outside the evidence directory through the alias, including a ..-prefixed knowledge-base file', async () => {
    const { root, alias, runDir, via } = await projectWithRun();
    fs.mkdirSync(path.join(root, 'knowledge_base'));
    fs.writeFileSync(path.join(root, 'knowledge_base', '..notes.md'), 'note\n');
    fs.mkdirSync(path.join(runDir, 'kb_profile'));
    fs.writeFileSync(path.join(runDir, 'kb_profile', 'kb_profile.json'), JSON.stringify({ selected: [{ path: 'knowledge_base/..notes.md' }] }));
    const out = path.join(via(root), 'exports', 'ok.zip');
    expect(await runCli([`--project-root=${alias}`, 'export', '--run-id', 'r-one', '--include-kb-profile', '--out', out], makeIo(alias).io)).toBe(0);
    const listing = execFileSync('unzip', ['-Z1', path.join(root, 'exports', 'ok.zip')], { encoding: 'utf-8' });
    expect(listing.split('\n')).toContain('knowledge_base/..notes.md');
  });
});

describe('nullius export of knowledge-base files', () => {
  it('refuses a knowledge-base entry that is a symlink to a file outside the project', async () => {
    const { parent, root, alias } = aliasedProject();
    await initProject(root);
    const runDir = path.join(root, 'artifacts', 'runs', 'r-one');
    fs.mkdirSync(path.join(runDir, 'kb_profile'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'result.json'), '{}\n');
    fs.writeFileSync(path.join(parent, 'secret.txt'), 'outside bytes\n');
    fs.mkdirSync(path.join(root, 'knowledge_base'));
    fs.symlinkSync(path.join(parent, 'secret.txt'), path.join(root, 'knowledge_base', 'linked-secret.md'));
    fs.writeFileSync(path.join(runDir, 'kb_profile', 'kb_profile.json'), JSON.stringify({ selected: [{ path: 'knowledge_base/linked-secret.md' }] }));
    await expect(runCli([`--project-root=${alias}`, 'export', '--run-id', 'r-one', '--include-kb-profile', '--out', path.join(parent, 'out.zip')], makeIo(alias).io))
      .rejects.toThrow(/kb-profile export safety check failed[\s\S]*symlink/);
    expect(fs.existsSync(path.join(parent, 'out.zip'))).toBe(false);
  });
});

describe('trace verbs addressing a run through an alias of the project root', () => {
  it('trace void accepts the alias spelling and still refuses escapes and symlinked runs', async () => {
    const { parent, root, alias, via } = aliasedProject();
    await initProject(root);
    const runDir = path.join(root, 'artifacts', 'runs', 'r-one');
    fs.mkdirSync(runDir, { recursive: true });
    fs.symlinkSync(runDir, path.join(root, 'artifacts', 'runs', 'r-link'), 'dir');
    fs.mkdirSync(path.join(parent, 'other', 'artifacts', 'runs', 'r-one'), { recursive: true });

    const escaped = makeIo(alias);
    expect(await runCli([`--project-root=${alias}`, 'trace', 'void', path.join(parent, 'other', 'artifacts', 'runs', 'r-one'), '--reason', 'x'], escaped.io)).not.toBe(0);
    expect(escaped.stderr.join('') + escaped.stdout.join('')).toMatch(/outside the project root/);
    const linked = makeIo(alias);
    expect(await runCli([`--project-root=${alias}`, 'trace', 'void', path.join(via(root), 'artifacts', 'runs', 'r-link'), '--reason', 'x'], linked.io)).not.toBe(0);
    expect(readValidityLedger(root).runs.has('r-one')).toBe(false);

    expect(await runCli([`--project-root=${alias}`, 'trace', 'void', via(runDir), '--reason', 'x'], makeIo(alias).io)).toBe(0);
    expect(readValidityLedger(root).runs.get('r-one')?.validity).toBe('void');
  });

  it('trace void never records a verdict through a symlinked run root', async () => {
    const { parent, root, alias, via } = aliasedProject();
    await initProject(root);
    const external = path.join(parent, 'external-runs');
    fs.mkdirSync(path.join(external, 'r-one'), { recursive: true });
    fs.rmSync(path.join(root, 'artifacts', 'runs'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.symlinkSync(external, path.join(root, 'artifacts', 'runs'), 'dir');
    const code = await runCli([`--project-root=${alias}`, 'trace', 'void', path.join(via(root), 'artifacts', 'runs', 'r-one'), '--reason', 'x'], makeIo(alias).io)
      .catch(() => 1);
    expect(code).not.toBe(0);
    expect(fs.readdirSync(external)).toEqual(['r-one']);
  });

  it('trace void never appends to a ledger attributes file that is a symlink to a file outside the project', async () => {
    const { parent, root, alias, via } = aliasedProject();
    await initProject(root);
    const runDir = path.join(root, 'artifacts', 'runs', 'r-one');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(parent, 'outside-attributes'), 'unrelated\n');
    fs.rmSync(path.join(root, 'artifacts', 'runs', '.gitattributes'), { force: true });
    fs.symlinkSync(path.join(parent, 'outside-attributes'), path.join(root, 'artifacts', 'runs', '.gitattributes'));
    expect(await runCli([`--project-root=${alias}`, 'trace', 'void', via(runDir), '--reason', 'x'], makeIo(alias).io)).toBe(0);
    expect(readValidityLedger(root).runs.get('r-one')?.validity).toBe('void');
    expect(fs.readFileSync(path.join(parent, 'outside-attributes'), 'utf-8')).toBe('unrelated\n');
  });

  it('trace retry through the alias never quarantines a git-tracked file of the run', () => {
    const { root, via } = aliasedProject();
    execFileSync('git', ['-C', root, 'init', '-q']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 't@example.com']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'T']);
    const runDir = path.join(root, 'artifacts', 'runs', 'r-retry');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n');
    execFileSync('git', ['-C', root, 'add', '-A']);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'seed']);
    expect(stampRunDirectory(root, via(runDir), { actor: 'test' }).kind).toBe('stamped');
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'execution_status.json'), JSON.stringify({ status: 'failed', errors: ['x'] }));
    fs.writeFileSync(path.join(runDir, 'fixed_script.jl'), 'x = 1\n');
    execFileSync('git', ['-C', root, 'add', path.join('artifacts', 'runs', 'r-retry', 'fixed_script.jl')]);
    execFileSync('git', ['-C', root, 'commit', '-q', '-m', 'fix']);

    const result = openRetryAttempt(root, via(runDir), { actor: 'test' });
    expect(result.kind).toBe('retried');
    expect(fs.existsSync(path.join(runDir, 'fixed_script.jl'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'attempts', 'attempt-1', 'fixed_script.jl'))).toBe(false);
    expect(execFileSync('git', ['-C', root, 'status', '--porcelain', '--', 'artifacts/runs/r-retry/fixed_script.jl'], { encoding: 'utf-8' })).toBe('');
  });

  it('trace stamp refuses a run reached through a symlink below the project root, so nothing is written outside it', () => {
    const { parent, root, via } = aliasedProject();
    const external = path.join(parent, 'external-runs');
    fs.mkdirSync(path.join(external, 'r1'), { recursive: true });
    fs.mkdirSync(path.join(root, 'artifacts'));
    fs.symlinkSync(external, path.join(root, 'artifacts', 'runs'), 'dir');
    for (const target of [path.join(root, 'artifacts', 'runs', 'r1'), path.join(via(root), 'artifacts', 'runs', 'r1')]) {
      expect(stampRunDirectory(root, target, { actor: 'test' })).toMatchObject({
        kind: 'rejected', message: expect.stringMatching(/passes through the symlink/),
      });
    }
    expect(fs.readdirSync(path.join(external, 'r1'))).toEqual([]);
  });

  it('trace stamp refuses a run reached through a symlink outside the project that points into its run root', () => {
    const { parent, root } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    fs.symlinkSync(path.join(root, 'artifacts', 'runs'), path.join(parent, 'runs-link'), 'dir');
    expect(stampRunDirectory(root, path.join(parent, 'runs-link', 'r1'), { actor: 'test' })).toMatchObject({
      kind: 'rejected', message: expect.stringMatching(/outside the run root/),
    });
    expect(fs.readdirSync(runDir)).toEqual([]);
  });

  it('trace stamp names a historical run root reached through the alias as historical', () => {
    const { root, via } = aliasedProject();
    const historical = path.join(root, 'team', 'runs', 'old');
    fs.mkdirSync(historical, { recursive: true });
    const result = stampRunDirectory(root, via(historical), { actor: 'test' });
    expect(result).toMatchObject({ kind: 'rejected', message: expect.stringMatching(/team\/runs is historical read-only evidence/) });
  });
});

describe('MCP computation entry with run_dir and manifest_path spelled differently', () => {
  function runWithManifest() {
    const project = aliasedProject();
    const runId = 'mixed-spelling';
    const runDir = path.join(project.root, 'artifacts', 'runs', runId);
    fs.mkdirSync(path.join(runDir, 'computation'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'computation', 'entry.py'), 'print(1)\n');
    const manifestPath = path.join(runDir, 'computation', 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'entry.py', tool: 'python' },
      steps: [{ id: 'compute', tool: 'python', script: 'entry.py', expected_outputs: ['out.json'] }],
      environment: { platform: 'any' },
      dependencies: {},
    }));
    return { ...project, runId, runDir, manifestPath };
  }

  it('accepts an alias run_dir with a canonical manifest_path and the reverse, as one run', async () => {
    const { root, alias, via, runId, runDir, manifestPath } = runWithManifest();
    await expect(handleOrchRunExecuteManifest({
      project_root: alias, run_id: runId, run_dir: via(runDir), manifest_path: manifestPath, dry_run: true,
    })).resolves.toMatchObject({ status: 'dry_run', manifest_path: 'computation/manifest.json' });
    await expect(handleOrchRunExecuteManifest({
      project_root: root, run_id: runId, run_dir: runDir, manifest_path: via(manifestPath), dry_run: true,
    })).resolves.toMatchObject({ status: 'dry_run', manifest_path: 'computation/manifest.json' });
  });

  it('still refuses a manifest outside the run directory and one reached through a symlink below it', async () => {
    const { parent, alias, via, runId, runDir, manifestPath } = runWithManifest();
    const elsewhere = path.join(parent, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.copyFileSync(manifestPath, path.join(elsewhere, 'manifest.json'));
    await expect(handleOrchRunExecuteManifest({
      project_root: alias, run_id: runId, run_dir: via(runDir), manifest_path: path.join(elsewhere, 'manifest.json'), dry_run: true,
    })).rejects.toThrow(/manifest_path must be within/);
    fs.symlinkSync(elsewhere, path.join(runDir, 'computation', 'linked'), 'dir');
    await expect(handleOrchRunExecuteManifest({
      project_root: alias, run_id: runId, run_dir: via(runDir), manifest_path: path.join(runDir, 'computation', 'linked', 'manifest.json'), dry_run: true,
    })).rejects.toThrow(/symbolic link/);
  });
});

describe('approved execution inputs named by step arguments', () => {
  it('binds a ..-prefixed workspace file and a workspace file named through the alias, which the argument gate admits', () => {
    const { root, via } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'arg-binding');
    const workspace = path.join(runDir, 'computation');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'entry.py'), 'print(1)\n');
    fs.writeFileSync(path.join(workspace, '..data.txt'), 'dotted\n');
    fs.writeFileSync(path.join(workspace, 'aliased.txt'), 'aliased\n');
    const manifest = {
      schema_version: 1,
      entry_point: { script: 'entry.py', tool: 'python' },
      steps: [{ id: 'compute', tool: 'python', script: 'entry.py', args: ['..data.txt', via(path.join(workspace, 'aliased.txt'))], expected_outputs: ['out.json'] }],
      environment: { platform: 'any' },
      dependencies: {},
    };
    const manifestPath = path.join(workspace, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const prepared = prepareManifest({ projectRoot: root, runDir, runId: 'arg-binding', manifestPath });

    expect(() => assertStepPathArgumentsDeclared({ externalRefs: [], manifest: prepared.manifest, workspaceDir: workspace })).not.toThrow();
    const before = executionBinding(root, prepared);
    const bound = (before.content.inputs as Array<{ path: string }>).map(input => input.path);
    expect(bound).toEqual(expect.arrayContaining([path.join(workspace, '..data.txt'), path.join(workspace, 'aliased.txt')]));
    for (const name of ['..data.txt', 'aliased.txt']) {
      const original = fs.readFileSync(path.join(workspace, name));
      fs.writeFileSync(path.join(workspace, name), 'changed after approval\n');
      expect(executionBinding(root, prepared).sha256).not.toBe(before.sha256);
      fs.writeFileSync(path.join(workspace, name), original);
    }
  });
});

describe('review follow-up gate artifacts', () => {
  it('never reads a recorded artifact through a symlink below the run directory', () => {
    const { parent, root } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'crafted.json'), '{}\n');
    fs.symlinkSync(path.join(parent, 'crafted.json'), path.join(runDir, 'artifacts', 'subject.json'));
    const ref = (name: string) => ({ uri: `rep://runs/r1/artifact/${encodeURIComponent(`artifacts/${name}`)}`, sha256: '0'.repeat(64), kind: 'x' });
    const bridge = {
      bridge_kind: 'review',
      run_id: 'r1',
      verification_refs: { subject_refs: [ref('subject.json')], subject_verdict_refs: [ref('verdict.json')], coverage_refs: [ref('coverage.json')] },
    };
    expect(evaluateReviewFollowupGate({ bridge: bridge as never, runDir })).toMatchObject({
      decision: 'unavailable', reason: expect.stringMatching(/symbolic link/),
    });
  });
});

describe('declared computation outputs', () => {
  it('refuses, before anything runs, an expected output under a dangling symlink below the workspace', () => {
    const { parent, root } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'dangling-output');
    const workspace = path.join(runDir, 'computation');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'entry.py'), 'print(1)\n');
    fs.symlinkSync(path.join(parent, 'not-yet-created'), path.join(workspace, 'out'), 'dir');
    const manifestPath = path.join(workspace, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema_version: 1,
      entry_point: { script: 'entry.py', tool: 'python' },
      steps: [{ id: 'compute', tool: 'python', script: 'entry.py', expected_outputs: ['out/result.json'] }],
      environment: { platform: 'any' },
      dependencies: {},
    }));
    expect(() => prepareManifest({ projectRoot: root, runDir, runId: 'dangling-output', manifestPath })).toThrow(/symbolic link/);
  });
});

describe('native runtime selection excludes runtimes inside the run or the project', () => {
  function plantRuntime(directory: string): string {
    fs.mkdirSync(directory, { recursive: true });
    const runtime = path.join(directory, 'python3');
    fs.writeFileSync(runtime, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]));
    fs.chmodSync(runtime, 0o755);
    return runtime;
  }
  function selectedWith(pathEntry: string, projectRoot: string, runDir: string): string | null {
    const prior = process.env.PATH;
    process.env.PATH = pathEntry;
    try {
      return resolveCanonicalNativeRuntime({ projectRoot, runDir, token: 'python3' }).canonical_path;
    } catch {
      return null;
    } finally {
      process.env.PATH = prior;
    }
  }

  it('when the project root is spelled through the alias and the search path names the canonical directory', () => {
    const { root, alias, via } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    const planted = plantRuntime(path.join(root, 'bin'));
    expect(selectedWith(path.dirname(planted), alias, via(runDir))).not.toBe(planted);
  });

  it('when the runtime sits in a ..-prefixed directory of the project', () => {
    const { root } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'r1');
    fs.mkdirSync(runDir, { recursive: true });
    const planted = plantRuntime(path.join(root, '..bin'));
    expect(selectedWith(path.dirname(planted), root, runDir)).not.toBe(planted);
  });
});

describe('recorded evidence pointers', () => {
  it('reads evidence spelled through the alias and still refuses escapes and symlinks below the root', () => {
    const { parent, root, via } = aliasedProject();
    const file = path.join(root, 'artifacts', 'runs', 'r1', 'evidence.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    expect(resolveEvidencePath(root, via(file))).toBe(file);
    fs.mkdirSync(path.join(parent, 'outside'));
    expect(() => resolveEvidencePath(root, path.join(parent, 'outside', 'x.json'))).toThrow(/escapes the project/);
    fs.symlinkSync(path.dirname(file), path.join(root, 'linked'), 'dir');
    expect(() => resolveEvidencePath(root, path.join(via(root), 'linked', 'evidence.json'))).toThrow(/symlink/);
  });

  it('a state pointer recorded under the alias spelling still names the proposal', () => {
    const { root, via } = aliasedProject();
    const proposalPath = path.join(root, 'artifacts', 'runs', 'r1', 'skill_proposal_v2.json');
    fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
    fs.writeFileSync(proposalPath, JSON.stringify({ proposal_id: 'p1', proposal_type: 'skill', name: 'n', trigger: { pattern_kind: 'k' } }));
    const state = { run_id: 'r1', artifacts: { skill_proposal_v2: via(proposalPath) } } as unknown as RunState;
    const view = readSkillProposalView(root, state);
    // No decision store exists here; only the pointer resolution is under test.
    expect(view.skill_proposal_error?.code).not.toBe('SKILL_PROPOSAL_INVALID');
    expect(view.skill_proposal).toMatchObject({ proposal_id: 'p1' });
  });
});

describe('proposal decisions', () => {
  function stateFor(pointer: string): RunState {
    return { run_id: 'r1', artifacts: { skill_proposal_v2: pointer } } as unknown as RunState;
  }
  const proposal = JSON.stringify({ proposal_id: 'p1', proposal_type: 'skill', name: 'n', trigger: { pattern_kind: 'k' } });

  it('record against a proposal named through the alias, and never against one reached through a symlink below the root', () => {
    const { parent, root, via } = aliasedProject();
    const inside = path.join(root, 'artifacts', 'runs', 'r1', 'skill_proposal_v2.json');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, proposal);
    fs.mkdirSync(path.join(parent, 'external'));
    fs.writeFileSync(path.join(parent, 'external', 'proposal.json'), proposal);
    fs.symlinkSync(path.join(parent, 'external'), path.join(root, 'linked'), 'dir');
    const decide = (pointer: string) => recordProposalDecision({
      projectRoot: root, state: stateFor(pointer), proposalKind: 'skill', proposalId: 'p1', decision: 'dismissed',
    });
    expect(() => decide('linked/proposal.json')).toThrow(/proposal pointer is invalid/);
    expect(decide(via(inside))).toMatchObject({ proposal_id: 'p1', decision: 'dismissed' });
  });
});

describe('notebook review dependencies', () => {
  it('admits an explicit dependency spelled through the alias and keeps refusing one outside the project', () => {
    const { parent, root, via } = aliasedProject();
    fs.writeFileSync(path.join(root, 'research_notebook.md'), '# Notebook\n\nA result.\n');
    fs.mkdirSync(path.join(root, 'notes'));
    fs.writeFileSync(path.join(root, 'notes', 'derivation.md'), 'Derivation.\n');
    const runDir = path.join(root, 'artifacts', 'runs', 'nb-review');
    fs.mkdirSync(runDir, { recursive: true });
    const scope = freezeNotebookReviewScope(root, 'nb-review', runDir, [path.join(via(root), 'notes', 'derivation.md')]);
    expect(scope.explicit_dependencies).toEqual(['notes/derivation.md']);
    fs.writeFileSync(path.join(parent, 'outside.md'), 'x\n');
    expect(() => freezeNotebookReviewScope(root, 'nb-review-2', path.join(root, 'artifacts', 'runs', 'nb-review-2'), [path.join(parent, 'outside.md')]))
      .toThrow(/--dependency must stay within/);
  });
});

describe('notebook reviewer report receipts', () => {
  it('bind the report named through the alias and never one reached through a symlink below the run', () => {
    const { parent, root, via } = aliasedProject();
    const runDir = path.join(root, 'artifacts', 'runs', 'nb-review');
    fs.mkdirSync(path.join(runDir, 'review'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'review', 'report.json'), '{}\n');
    expect(reviewerReportRef('nb-review', runDir, path.join(via(runDir), 'review', 'report.json'))?.uri)
      .toBe(`rep://runs/nb-review/artifact/${encodeURIComponent('review/report.json')}`);
    fs.mkdirSync(path.join(parent, 'outside'));
    fs.writeFileSync(path.join(parent, 'outside', 'report.json'), '{}\n');
    fs.symlinkSync(path.join(parent, 'outside'), path.join(runDir, 'review', 'linked'), 'dir');
    expect(() => reviewerReportRef('nb-review', runDir, path.join(via(runDir), 'review', 'linked', 'report.json'))).toThrow(/symbolic link/);
  });
});

describe('display of control-directory paths', () => {
  it('shows a ..-prefixed control directory inside the project as a project-relative path', () => {
    const { root } = aliasedProject();
    const prior = process.env.NULLIUS_CONTROL_DIR;
    process.env.NULLIUS_CONTROL_DIR = path.join(root, '..control');
    try {
      expect(decisionsLedgerDisplayPath(root)).toBe('..control/decisions.jsonl');
    } finally {
      if (prior === undefined) delete process.env.NULLIUS_CONTROL_DIR;
      else process.env.NULLIUS_CONTROL_DIR = prior;
    }
  });
});
