import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { withExplicitHandoffMethod } from './explicitArtifactWriterMethod.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handleToolCall, stageIdeaArtifactsIntoRun } from '../src/index.js';
import { keepStagedCreatedAt } from '../src/computation/materialize-execution-plan.js';
import { StateManager } from '../src/state-manager.js';

function makeTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function extractPayload(res: unknown): Record<string, unknown> {
  const result = res as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

function makeHandoff(): Record<string, unknown> {
  return withExplicitHandoffMethod({
    campaign_id: 'cccccc01',
    node_id: 'nnnnnn02',
    idea_id: 'dddddd03',
    promoted_at: '2026-03-13T00:00:00Z',
    idea_card: {
      thesis_statement: 'Generic staged planning should compile a run directory inside the project through orch_run_plan_computation.',
      testable_hypotheses: ['Hypothesis A'],
      required_observables: ['observable_a'],
      minimal_compute_plan: [
        { step: 'Derive a consistency relation', method: 'structured derivation', estimated_difficulty: 'moderate' },
      ],
      claims: [{ claim_text: 'Claim A', support_type: 'literature', evidence_uris: ['https://inspirehep.net/literature/1'] }],
    },
    grounding_audit: {
      status: 'pass',
      folklore_risk_score: 0.1,
      failures: [],
      timestamp: '2026-03-13T00:00:00Z',
    },
  });
}

function makeProviderBackedHandoff(): Record<string, unknown> {
  return {
    ...makeHandoff(),
    idea_card: {
      ...(makeHandoff().idea_card as Record<string, unknown>),
      thesis_statement: 'Provider-backed staged planning should stay on the public orch_* path.',
      method_spec: {
        files: [
          {
            path: 'scripts/write_provider_result.py',
            content: [
              'import json',
              'from pathlib import Path',
              '',
              "Path('results').mkdir(parents=True, exist_ok=True)",
              "Path('results/provider_result.json').write_text(json.dumps({'provider_backed': True}) + '\\n', encoding='utf-8')",
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

const CLEANUP_DIRS: string[] = [];

afterEach(() => {
  while (CLEANUP_DIRS.length > 0) {
    fs.rmSync(CLEANUP_DIRS.pop()!, { recursive: true, force: true });
  }
});

describe('orch_run_plan_computation tool', () => {
  it('compiles staged idea artifacts from a run directory inside the project', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = fs.mkdtempSync(path.join(projectRoot, 'orch-plan-run-'));
    CLEANUP_DIRS.push(projectRoot, runDir);

    stageIdeaArtifactsIntoRun({
      handoffRecord: makeHandoff(),
      handoffUri: path.join(runDir, 'source-handoff.json'),
      runDir,
    });

    const result = await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-001',
        run_dir: runDir,
        dry_run: true,
      },
      'full',
    );

    const payload = extractPayload(result);
    expect(payload.status).toBe('dry_run');
    expect(payload.execution_plan_path).toBe('computation/execution_plan_v1.json');
    expect(payload.manifest_path).toBe('computation/manifest.json');
    expect(payload.task_ids).toEqual(['task_001']);
  });

  it('keeps the supplied provider-backed operation on the public orch_* path', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = fs.mkdtempSync(path.join(projectRoot, 'orch-plan-run-'));
    CLEANUP_DIRS.push(projectRoot, runDir);

    stageIdeaArtifactsIntoRun({
      handoffRecord: makeProviderBackedHandoff(),
      handoffUri: path.join(runDir, 'source-provider-handoff.json'),
      runDir,
    });

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), 'run-provider-001', 'computation');
    fs.writeFileSync(manager.policyPath, JSON.stringify({ require_approval_for: { compute_runs: true } }) + '\n', 'utf-8'); // A3 is opt-in; enable it to exercise the gate

    const planned = extractPayload(await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-provider-001',
        run_dir: runDir,
        dry_run: false,
      },
      'full',
    ));

    expect(planned.status).toBe('requires_approval');
    const manifest = JSON.parse(fs.readFileSync(path.join(runDir, String(planned.manifest_path)), 'utf-8')) as {
      description?: string;
      entry_point: { script: string; tool: string };
    };
    expect(manifest.description).toContain('Provider-backed execution materialized from staged method_spec.run_card');
    expect(manifest.entry_point).toMatchObject({
      script: 'scripts/write_provider_result.py',
      tool: 'python',
    });
    expect(fs.existsSync(path.join(runDir, 'computation', 'scripts', 'execution_plan_runner.py'))).toBe(false);

    manager.approveRun(manager.readState(), String(planned.approval_id), 'approve provider-backed test');

    const executed = extractPayload(await handleToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-provider-001',
        run_dir: runDir,
        manifest_path: String(planned.manifest_path),
      },
      'full',
    ));

    expect(executed.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'results', 'provider_result.json'))).toBe(true);
  });

  it('keeps an A3 approval valid when planning is repeated later from unchanged inputs, and re-gates changed inputs', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = fs.mkdtempSync(path.join(projectRoot, 'orch-plan-run-'));
    CLEANUP_DIRS.push(projectRoot, runDir);
    // This method passes the execution plan to its script, so the plan file is
    // an approved input alongside the manifest.
    stageIdeaArtifactsIntoRun({
      handoffRecord: makeHandoff(),
      handoffUri: path.join(runDir, 'source-handoff.json'),
      runDir,
    });
    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), 'run-provider-replan', 'computation');
    fs.writeFileSync(manager.policyPath, JSON.stringify({ require_approval_for: { compute_runs: true } }) + '\n', 'utf-8');
    const plan = async () => extractPayload(await handleToolCall('orch_run_plan_computation', {
      project_root: projectRoot,
      run_id: 'run-provider-replan',
      run_dir: runDir,
      dry_run: false,
    }, 'full'));
    const manifestPath = path.join(runDir, 'computation', 'manifest.json');
    const executionPlanPath = path.join(runDir, 'computation', 'execution_plan_v1.json');

    const first = await plan();
    expect(first).toMatchObject({ status: 'requires_approval', approval_id: 'A3-0001' });
    const approvedBytes = fs.readFileSync(manifestPath, 'utf-8');
    const approvedPlanBytes = fs.readFileSync(executionPlanPath, 'utf-8');
    manager.approveRun(manager.readState(), 'A3-0001', 'approve provider-backed plan');

    // Human approval takes real time; planning again afterwards must reproduce
    // the approved manifest bytes rather than restamp them.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse(JSON.parse(approvedBytes).created_at) + 3_600_000);
      await expect(plan()).resolves.toMatchObject({ status: 'planned', requires_approval: false });
      expect(fs.readFileSync(manifestPath, 'utf-8')).toBe(approvedBytes);
      expect(fs.readFileSync(executionPlanPath, 'utf-8')).toBe(approvedPlanBytes);

      const hintsPath = path.join(runDir, 'artifacts', 'idea_handoff_hints_v1.json');
      const hints = JSON.parse(fs.readFileSync(hintsPath, 'utf-8')) as {
        hints: { method_spec: { run_card: { phases: Array<{ backend: { timeout_seconds: number } }> } } };
      };
      hints.hints.method_spec.run_card.phases[0]!.backend.timeout_seconds = 600;
      fs.writeFileSync(hintsPath, `${JSON.stringify(hints, null, 2)}\n`, 'utf-8');
      await expect(plan()).resolves.toMatchObject({ status: 'requires_approval', approval_id: 'A3-0002' });
      const replanned = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as { created_at: string; steps: Array<{ timeout_minutes?: number }> };
      expect(replanned.steps[0]!.timeout_minutes).toBe(10);
      expect(replanned.created_at).not.toBe(JSON.parse(approvedBytes).created_at);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a ready-to-execute planned result (no approval) when A3 (compute_runs) is opt-out by default', async () => {
    const projectRoot = makeTmpDir('orch-plan-project-');
    const runDir = fs.mkdtempSync(path.join(projectRoot, 'orch-plan-run-'));
    CLEANUP_DIRS.push(projectRoot, runDir);

    stageIdeaArtifactsIntoRun({
      handoffRecord: makeProviderBackedHandoff(),
      handoffUri: path.join(runDir, 'source-provider-handoff.json'),
      runDir,
    });

    const manager = new StateManager(projectRoot);
    manager.createRun(manager.readState(), 'run-provider-a3off', 'computation');
    // No approval_policy.json written → compute_runs defaults OFF (A3 opt-out).

    const planned = extractPayload(await handleToolCall(
      'orch_run_plan_computation',
      {
        project_root: projectRoot,
        run_id: 'run-provider-a3off',
        run_dir: runDir,
        dry_run: false,
      },
      'full',
    ));

    // Planning-only bridge: no approval gate, so it returns a staged-and-ready plan.
    expect(planned.status).toBe('planned');
    expect(planned.requires_approval).toBe(false);
    expect(planned.approval_id).toBeUndefined();
    expect(planned.manifest_path).toBe('computation/manifest.json');

    // No approval was created — the run executes directly via orch_run_execute_manifest.
    const executed = extractPayload(await handleToolCall(
      'orch_run_execute_manifest',
      {
        _confirm: true,
        project_root: projectRoot,
        run_id: 'run-provider-a3off',
        run_dir: runDir,
        manifest_path: String(planned.manifest_path),
      },
      'full',
    ));

    expect(executed.status).toBe('completed');
    expect(fs.existsSync(path.join(runDir, 'computation', 'results', 'provider_result.json'))).toBe(true);
  });
});

describe('keepStagedCreatedAt', () => {
  it('reuses only a well-formed staged timestamp of otherwise identical content', () => {
    const dir = makeTmpDir('orch-plan-stamp-');
    CLEANUP_DIRS.push(dir);
    const file = path.join(dir, 'artifact.json');
    const fresh = { schema_version: 1, value: 'x', nested: { a: 1, b: 2 }, created_at: '2026-10-09T02:00:00Z' };
    expect(keepStagedCreatedAt(file, fresh)).toBe(fresh);

    const cases: Array<[unknown, string]> = [
      [{ ...fresh, created_at: '2026-10-09T01:00:00Z' }, '2026-10-09T01:00:00Z'],
      [{ created_at: '2026-10-09T01:00:00Z', nested: { b: 2, a: 1 }, value: 'x', schema_version: 1 }, '2026-10-09T01:00:00Z'],
      [{ ...fresh, value: 'y', created_at: '2026-10-09T01:00:00Z' }, fresh.created_at],
      [{ ...fresh, created_at: 'not-a-date' }, fresh.created_at],
      [{ ...fresh, created_at: '2026-02-30T00:00:00Z' }, fresh.created_at],
      [{ ...fresh, created_at: '2026-10-09T01:00:00.000Z' }, fresh.created_at],
      [{ ...fresh, created_at: 7 }, fresh.created_at],
      [{ schema_version: 1, value: 'x', nested: { a: 1, b: 2 } }, fresh.created_at],
    ];
    for (const [staged, expected] of cases) {
      fs.writeFileSync(file, JSON.stringify(staged), 'utf-8');
      expect(keepStagedCreatedAt(file, fresh).created_at).toBe(expected);
    }
    fs.writeFileSync(file, '{not json', 'utf-8');
    expect(keepStagedCreatedAt(file, fresh)).toBe(fresh);
  });
});
