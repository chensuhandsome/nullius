import * as fs from 'node:fs';
import * as path from 'node:path';
import { withExplicitSurfaceMethod } from './explicitArtifactWriterMethod.js';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => {
    throw new Error('spawnSync must not be called by compute bridge pre-approval paths');
  }),
}));

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { bridgeStagedIdeaToComputation } from '../src/computation/bridge.js';
import { handleToolCall } from '../src/tooling.js';
import {
  cleanupRegisteredDirs,
  initRunState,
  makeTmpDir,
  markA3Satisfied,
  registerCleanup,
  writeJson,
} from './executeManifestTestUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const executionPlanSchema = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../meta/schemas/execution_plan_v1.schema.json'), 'utf-8'),
) as Record<string, unknown>;

function stagedIdeaSurface() {
  return withExplicitSurfaceMethod({
    outline_seed_path: 'artifacts/outline_seed_v1.json',
    outline: {
      thesis: 'Bridge staged hypotheses into a provider-neutral execution plan before any compute approval.',
      claims: [{ claim_text: 'Claim A' }],
      hypotheses: ['Hypothesis A', 'Hypothesis B'],
      source_handoff_uri: 'provider://records/source-run/artifact/idea_handoff_c2_v1.json',
    },
    hints: {
      campaign_id: 'cccccc01',
      node_id: 'nnnnnn02',
      idea_id: 'dddddd03',
      promoted_at: '2026-03-13T00:00:00Z',
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Assemble consistency equations', method: 'structured derivation', estimated_difficulty: 'moderate' },
      ],
    },
  });
}

function stagedIdeaSurfaceWithProviderBundle() {
  return {
    ...stagedIdeaSurface(),
    hints: {
      ...stagedIdeaSurface().hints,
      method_spec: {
        files: [
          {
            path: 'scripts/write_provider_result.py',
            content: [
              'from pathlib import Path',
              "Path('results').mkdir(parents=True, exist_ok=True)",
              "Path('results/provider_result.json').write_text('{\"ok\": true}\\n', encoding='utf-8')",
              '',
            ].join('\n'),
          },
        ],
        run_card: {
          schema_version: 2,
          run_id: 'provider-run-card',
          workflow_id: 'computation',
          title: 'Provider-backed execution bundle',
          phases: [
            {
              phase_id: 'provider_phase',
              description: 'Write a provider-backed structured result',
              backend: {
                kind: 'shell',
                argv: ['python3', 'scripts/write_provider_result.py'],
                cwd: '.',
                timeout_seconds: 30,
              },
              outputs: ['results/provider_result.json'],
            },
          ],
        },
      },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  spawnSyncMock.mockClear();
  cleanupRegisteredDirs();
});

describe('compute bridge', () => {
  it('compiles staged idea input into execution_plan_v1 and returns dry_run without spawning a process', async () => {
    const projectRoot = makeTmpDir();
    const runDir = path.join(projectRoot, 'run-bridge-dry');
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurface().outline);

    const result = await bridgeStagedIdeaToComputation({
      dryRun: true,
      projectRoot,
      runDir,
      runId: 'run-bridge-dry',
      stagedIdea: stagedIdeaSurface(),
    });

    expect(result.status).toBe('dry_run');
    expect(result.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(result.manifest_path).toBe('computation/manifest.json');
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const planPath = path.join(runDir, result.execution_plan_path);
    const validate = new Ajv2020({ allErrors: true, strict: false, validateFormats: false }).compile(executionPlanSchema);
    const executionPlan = JSON.parse(fs.readFileSync(planPath, 'utf-8')) as Record<string, unknown>;
    expect(validate(executionPlan), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect((executionPlan.tasks as Array<Record<string, unknown>>)[0]?.capabilities).toContain('observable_estimation');
  });

  it('materializes the explicitly supplied provider-backed method bundle', async () => {
    const projectRoot = makeTmpDir();
    const runDir = path.join(projectRoot, 'run-bridge-provider');
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurfaceWithProviderBundle().outline);

    const result = await bridgeStagedIdeaToComputation({
      dryRun: true,
      projectRoot,
      runDir,
      runId: 'run-bridge-provider',
      stagedIdea: stagedIdeaSurfaceWithProviderBundle(),
    });

    expect(result.status).toBe('dry_run');
    const manifestPath = path.join(runDir, result.manifest_path);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
      description?: string;
      entry_point: { script: string; tool: string };
      steps: Array<{ id: string; script: string; expected_outputs: string[] }>;
    };
    expect(manifest.description).toContain('Provider-backed execution materialized from staged method_spec.run_card');
    expect(manifest.entry_point).toMatchObject({
      script: 'scripts/write_provider_result.py',
      tool: 'python',
    });
    expect(manifest.steps).toMatchObject([
      {
        id: 'provider_phase',
        script: 'scripts/write_provider_result.py',
        expected_outputs: ['results/provider_result.json'],
      },
    ]);
    expect(fs.existsSync(path.join(runDir, 'computation', 'scripts', 'write_provider_result.py'))).toBe(true);
    expect(fs.existsSync(path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'))).toBe(false);
  });

  it('stops at requires_approval with an enriched A3 packet and still performs zero execution', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-approval';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    writeJson(path.join(runDir, 'artifacts', 'outline_seed_v1.json'), stagedIdeaSurface().outline);
    const manager = initRunState(projectRoot, runId);
    fs.writeFileSync(manager.policyPath, JSON.stringify({ require_approval_for: { compute_runs: true } }) + '\n', 'utf-8'); // A3 is opt-in; enable it to exercise the gate

    const result = await bridgeStagedIdeaToComputation({
      dryRun: false,
      projectRoot,
      runDir,
      runId,
      stagedIdea: stagedIdeaSurface(),
    });

    expect(result.status).toBe('requires_approval');
    expect(result.gate_id).toBe('A3');
    expect(spawnSyncMock).not.toHaveBeenCalled();

    const packetPath = path.join(projectRoot, result.packet_json_path);
    const packet = JSON.parse(fs.readFileSync(packetPath, 'utf-8')) as { details_md: string; risks: string[] };
    expect(packet.details_md).toContain('Bridge objective');
    expect(packet.details_md).toContain('Required observables: observable_a');
    expect(packet.risks.some(risk => risk.includes('Execution authority comes from the staged method bundle'))).toBe(true);
  });

  it('requests content-bound approval when a historical A3 marker has no packet', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-unbound-approval';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    const manager = initRunState(projectRoot, runId);
    fs.writeFileSync(manager.policyPath, JSON.stringify({ require_approval_for: { compute_runs: true } }) + '\n');
    markA3Satisfied(manager, 'A3-historical-unbound');
    const result = await bridgeStagedIdeaToComputation({ dryRun: false, projectRoot, runDir, runId, stagedIdea: stagedIdeaSurface() });
    expect(result.status).toBe('requires_approval');
    expect(result.gate_id).toBe('A3');
    expect(result.approval_id).not.toBe('A3-historical-unbound');
    expect(fs.existsSync(path.join(projectRoot, result.packet_json_path))).toBe(true);
    expect(manager.readState().gate_satisfied.A3).toBeUndefined();
    const executionPlan = JSON.parse(fs.readFileSync(path.join(runDir, 'computation', 'execution_plan_v1.json'), 'utf8')) as { tasks: Array<{ expected_artifacts: Array<{ path: string }> }> };
    const outputs = executionPlan.tasks.flatMap(task => task.expected_artifacts);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(fs.existsSync(path.join(runDir, 'computation', output.path))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('returns planned for an unchanged content-bound A3 approval and never executes via the bridge', async () => {
    // A fixed test clock keeps both regenerated manifests and plans byte-identical.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-13T00:00:00Z'));
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-approved';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    const manager = initRunState(projectRoot, runId);
    fs.writeFileSync(manager.policyPath, JSON.stringify({ require_approval_for: { compute_runs: true } }) + '\n');
    const input = { dryRun: false, projectRoot, runDir, runId, stagedIdea: stagedIdeaSurface() };
    const request = await bridgeStagedIdeaToComputation(input);
    expect(request.status).toBe('requires_approval');
    if (request.status !== 'requires_approval') throw new Error('approval request was not created');
    const approval = await handleToolCall('orch_run_approve', {
      _confirm: true, project_root: projectRoot, approval_id: request.approval_id,
      approval_packet_sha256: request.approval_packet_sha256, note: 'Approve the fixed test input.',
    }, 'full');
    expect(approval.isError).not.toBe(true);
    expect(JSON.parse(approval.content[0]!.text).approved).toBe(true);
    const approvalsDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals');
    const approvalsBefore = fs.readdirSync(approvalsDir);
    const manifestBefore = fs.readFileSync(path.join(runDir, request.manifest_path));
    const planBefore = fs.readFileSync(path.join(runDir, request.execution_plan_path));
    const planned = await bridgeStagedIdeaToComputation(input);
    expect(planned.status).toBe('planned');
    expect((planned as { requires_approval?: boolean }).requires_approval).toBe(false);
    expect(planned.manifest_path).toBe('computation/manifest.json');
    expect(fs.readFileSync(path.join(runDir, planned.manifest_path))).toEqual(manifestBefore);
    expect(fs.readFileSync(path.join(runDir, planned.execution_plan_path))).toEqual(planBefore);
    expect(fs.readdirSync(approvalsDir)).toEqual(approvalsBefore);
    expect(manager.readState().pending_approval).toBeNull();
    const executionPlan = JSON.parse(fs.readFileSync(path.join(runDir, 'computation', 'execution_plan_v1.json'), 'utf8')) as { tasks: Array<{ expected_artifacts: Array<{ path: string }> }> };
    const outputs = executionPlan.tasks.flatMap(task => task.expected_artifacts);
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(fs.existsSync(path.join(runDir, 'computation', output.path))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it('fails closed on invalid staged input and never creates an approval request', async () => {
    const projectRoot = makeTmpDir();
    const runId = 'run-bridge-invalid';
    const runDir = path.join(projectRoot, runId);
    registerCleanup(projectRoot);
    fs.mkdirSync(runDir, { recursive: true });
    initRunState(projectRoot, runId);

    await expect(() =>
      bridgeStagedIdeaToComputation({
        dryRun: false,
        projectRoot,
        runDir,
        runId,
        stagedIdea: {
          outline_seed_path: 'artifacts/outline_seed_v1.json',
          outline: { thesis: '', claims: [], hypotheses: [], source_handoff_uri: '' },
        },
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      data: expect.objectContaining({ validation_layer: 'staged_input' }),
    });
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals'))).toBe(false);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
