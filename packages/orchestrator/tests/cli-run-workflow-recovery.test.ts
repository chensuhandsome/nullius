import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommand, type RunCommandInput } from '../src/cli-run.js';
import { createToolAttemptIdentity, RunManifestManager } from '../src/run-manifest.js';
import { StateManager } from '../src/state-manager.js';
import { compileWorkflowRuntimeRequest, parsePersistedWorkflowExecution } from '../src/workflow-runtime.js';

function fixture(stepCount = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nullius-workflow-recovery-'));
  const manager = new StateManager(root);
  manager.ensureDirs();
  const state = manager.readState();
  state.run_id = 'generic-run';
  state.workflow_id = 'generic-workflow';
  state.plan = {
    schema_version: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    plan_id: 'generic-plan', run_id: state.run_id, workflow_id: state.workflow_id,
    current_step_id: 'step-1',
    steps: Array.from({ length: stepCount }, (_, index) => ({
      step_id: `step-${index + 1}`, description: 'Generic effect', status: 'pending',
      expected_approvals: [], expected_outputs: [], recovery_notes: '',
      execution: {
        action: null, tool: 'generic_effect', provider: null,
        depends_on: index ? ['step-1'] : [], params: { index: index + 1 },
        required_capabilities: [], degrade_mode: 'fail_closed', consumer_hints: null,
      },
    })),
  };
  manager.saveState(state);
  const output: string[] = [];
  const input: RunCommandInput = {
    command: 'run', projectRoot: root, workflowId: 'generic-workflow', runId: 'generic-run',
    runDir: null, manifestPath: null, dryRun: false,
  };
  return {
    root, manager, input, output,
    io: { cwd: root, stdout: (text: string) => output.push(text), stderr: () => {} },
    journal: new RunManifestManager(path.join(root, 'artifacts', 'runs')),
  };
}

const result = (index: number) => ({
  ok: true, isError: false, rawText: `result-${index}`, json: { index }, errorCode: null,
});

afterEach(() => vi.restoreAllMocks());

describe('persisted workflow dispatch recovery', () => {
  it.each(['paused', 'awaiting_approval'])('rejects another requested run before a %s receipt', async status => {
    const f = fixture();
    const state = f.manager.readState();
    state.run_status = status as 'paused' | 'awaiting_approval';
    f.manager.saveState(state);
    await expect(runCommand({ ...f.input, runId: 'another-run' }, f.io)).rejects.toThrow(/another run is active/);
    expect(f.output).toEqual([]);
  });

  it('leaves an approval-producing step unfinished, then dispatches it once after canonical approval', async () => {
    const f = fixture();
    const state = f.manager.readState();
    const first = (state.plan as { steps: Array<{ execution: { tool: string } }> }).steps[0]!;
    first.execution.tool = 'orch_run_execute_manifest';
    f.manager.saveState(state);
    const calls: number[] = [];
    let approvalId = '';
    const callTool = vi.fn(async (_name: string, params: Record<string, unknown>) => {
      calls.push(Number(params.index));
      if (params.index === 1 && !f.manager.readState().gate_satisfied.A3) {
        const packetPath = 'artifacts/runs/generic-run/approvals/A3-0001/packet.md';
        approvalId = f.manager.requestApproval(f.manager.readState(), 'A3', { packet_path: packetPath, plan_step_ids: ['step-1'] });
        const json = {
          status: 'requires_approval', requires_approval: true, gate_id: 'A3', run_id: 'generic-run',
          approval_id: approvalId, packet_path: packetPath, approval_packet_sha256: 'a'.repeat(64),
        };
        return { ok: true, isError: false, json, rawText: JSON.stringify(json), errorCode: null };
      }
      return result(Number(params.index));
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(calls).toEqual([1]);
    expect((f.manager.readState().plan as { steps: Array<{ status: string }> }).steps.map(step => step.status)).toEqual(['in_progress', 'pending']);
    const pending = f.journal.loadManifest('generic-run')!.pending_tool_intents[0]!;
    expect(pending).toMatchObject({ state: 'not_started', approval_boundary_count: 1, last_approval_boundary: { approval_id: approvalId } });
    f.manager.approveRun(f.manager.readState(), approvalId);
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(calls).toEqual([1, 1, 2]);
    expect(f.manager.readState().workflow_outputs['step-1']?.payload).toEqual({ index: 1 });
    expect(f.manager.readState().run_status).toBe('completed');
  });

  it.each(['fail_closed', 'skip_with_reason', 'partial_result'])('rejects an approval envelope with no matching canonical pending state even under %s', async degradeMode => {
    const f = fixture();
    const state = f.manager.readState();
    const execution = (state.plan as { steps: Array<{ execution: { tool: string; degrade_mode: string } }> }).steps[0]!.execution;
    execution.tool = 'orch_run_execute_manifest';
    execution.degrade_mode = degradeMode;
    f.manager.saveState(state);
    const json = {
      status: 'requires_approval', requires_approval: true, gate_id: 'A3', run_id: 'generic-run',
      approval_id: 'A3-0001', packet_path: 'artifacts/runs/generic-run/approvals/A3-0001/packet.md',
      approval_packet_sha256: 'a'.repeat(64),
    };
    const callTool = vi.fn(async () => ({ ok: true, isError: false, json, rawText: JSON.stringify(json), errorCode: null }));
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect((f.manager.readState().plan as { steps: Array<{ status: string }> }).steps.map(step => step.status)).toEqual(['failed', 'pending']);
    expect(f.journal.loadManifest('generic-run')?.checkpoints[0]?.outcome.json).toEqual(json);
    expect(f.output.join('')).toContain('canonical pending approval');
  });

  it('does not treat manually resumed lifecycle state as an approved dispatch boundary', async () => {
    const f = fixture(1);
    const state = f.manager.readState();
    (state.plan as { steps: Array<{ execution: { tool: string } }> }).steps[0]!.execution.tool = 'orch_run_execute_manifest';
    f.manager.saveState(state);
    const callTool = vi.fn(async () => {
      const packetPath = 'artifacts/runs/generic-run/approvals/A3-0001/packet.md';
      const approvalId = f.manager.requestApproval(f.manager.readState(), 'A3', { packet_path: packetPath, plan_step_ids: ['step-1'] });
      const json = {
        status: 'requires_approval', requires_approval: true, gate_id: 'A3', run_id: 'generic-run',
        approval_id: approvalId, packet_path: packetPath, approval_packet_sha256: 'a'.repeat(64),
      };
      return { ok: true, isError: false, json, rawText: JSON.stringify(json), errorCode: null };
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    const manuallyResumed = f.manager.readState();
    manuallyResumed.pending_approval = null;
    manuallyResumed.run_status = 'running';
    f.manager.saveState(manuallyResumed);
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(f.output.join('')).toContain('requires canonical approval');
  });

  it('preserves operator pause when an invalid approval response makes projection fail', async () => {
    const f = fixture(1);
    const callTool = vi.fn(async () => {
      f.manager.pauseRun(f.manager.readState(), 'operator pause');
      return { ok: true, isError: false, json: { status: 'requires_approval' }, rawText: 'invalid approval', errorCode: null };
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(f.manager.readState()).toMatchObject({ run_status: 'paused', notes: 'operator pause' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('does not repeat an effect whose response was lost, even after local recovery resumes the run', async () => {
    const f = fixture(1);
    const effectPath = path.join(f.root, 'effect.txt');
    const callTool = vi.fn(async () => {
      fs.appendFileSync(effectPath, 'effect\n');
      throw new Error('transport interrupted after effect');
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(f.manager.readState().run_status).toBe('needs_recovery');
    expect(f.journal.loadManifest('generic-run')?.pending_tool_intents[0]?.state).toBe('outcome_unknown');
    const state = f.manager.readState();
    state.run_status = 'running';
    f.manager.saveState(state);
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(effectPath, 'utf8')).toBe('effect\n');
    expect(JSON.parse(f.output.join('')).status).toBe('outcome_unknown');
  });

  it('replays a committed response after projection crashes without repeating the dispatch', async () => {
    const f = fixture();
    const original = StateManager.prototype.saveStateWithLedger;
    const projection = vi.spyOn(StateManager.prototype, 'saveStateWithLedger').mockImplementation(function (...args) {
      if (args[1] === 'workflow_step_completed') throw new Error('projection interrupted');
      return original.apply(this, args);
    });
    const callTool = vi.fn(async (_name: string, params: Record<string, unknown>) => result(Number(params.index)));
    await expect(runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).rejects.toThrow('projection interrupted');
    expect(f.journal.loadManifest('generic-run')?.checkpoints).toHaveLength(1);
    projection.mockRestore();
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool.mock.calls.map(call => call[1].index)).toEqual([1, 2]);
    expect(f.manager.readState().workflow_outputs['step-1']?.payload).toEqual({ index: 1 });
    expect(f.manager.readState().run_status).toBe('completed');
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('refuses an interrupted in-progress step without a durable dispatch record', async () => {
    const f = fixture(1);
    const state = f.manager.readState();
    state.run_status = 'running';
    ((state.plan as { steps: Array<{ status: string }> }).steps[0]!).status = 'in_progress';
    f.manager.saveState(state);
    const callTool = vi.fn(async () => result(1));
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(f.manager.readState().run_status).toBe('needs_recovery');
  });

  it('dispatches a durably observed but not-started attempt after reconnect', async () => {
    const f = fixture(1);
    const state = f.manager.readState();
    const first = (state.plan as { steps: Array<Record<string, unknown>> }).steps[0]!;
    const request = compileWorkflowRuntimeRequest({
      projectRoot: f.root, runId: 'generic-run', workflowId: 'generic-workflow',
      step: {
        step_id: 'step-1', description: 'Generic effect', status: 'pending',
        execution: parsePersistedWorkflowExecution(first.execution),
      },
    });
    f.journal.observeToolIntents('generic-run', [createToolAttemptIdentity({
      stepId: 'step-1', toolName: request.tool, input: request,
    })]);
    state.run_status = 'running';
    first.status = 'in_progress';
    f.manager.saveState(state);
    const callTool = vi.fn(async () => result(1));
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(f.journal.loadManifest('generic-run')?.pending_tool_intents).toEqual([]);
  });

  it('does not dispatch changed input when the same step already has a committed response', async () => {
    const f = fixture(1);
    const original = StateManager.prototype.saveStateWithLedger;
    const projection = vi.spyOn(StateManager.prototype, 'saveStateWithLedger').mockImplementation(function (...args) {
      if (args[1] === 'workflow_step_completed') throw new Error('projection interrupted');
      return original.apply(this, args);
    });
    const callTool = vi.fn(async () => result(1));
    await expect(runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).rejects.toThrow('projection interrupted');
    projection.mockRestore();
    const state = f.manager.readState();
    const first = (state.plan as { steps: Array<{ execution: { params: { index: number } } }> }).steps[0]!;
    first.execution.params.index = 9;
    f.manager.saveState(state);
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(f.output.join('')).toContain('tool-attempt identity conflict');
  });

  it('stops after an operator pauses the active step and resumes only the next step', async () => {
    const f = fixture();
    const callTool = vi.fn(async (_name: string, params: Record<string, unknown>) => {
      if (params.index === 1) f.manager.pauseRun(f.manager.readState(), 'operator pause');
      return result(Number(params.index));
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool.mock.calls.map(call => call[1].index)).toEqual([1]);
    expect(f.manager.readState()).toMatchObject({ run_status: 'paused', notes: 'operator pause' });
    expect(JSON.parse(f.output.join('')).status).toBe('paused');
    f.manager.resumeRun(f.manager.readState());
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool.mock.calls.map(call => call[1].index)).toEqual([1, 2]);
    expect(f.manager.readState().run_status).toBe('completed');
  });

  it('preserves pause when the last response completes and when run is called again', async () => {
    const f = fixture(1);
    const callTool = vi.fn(async () => {
      f.manager.pauseRun(f.manager.readState(), 'operator pause');
      return result(1);
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(f.manager.readState().run_status).toBe('paused');
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(f.manager.readState().run_status).toBe('paused');
    expect(callTool).toHaveBeenCalledTimes(1);
    f.manager.resumeRun(f.manager.readState());
    f.output.length = 0;
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(f.manager.readState().run_status).toBe('completed');
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('honors a pause sentinel written during the active call before the next dispatch', async () => {
    const f = fixture();
    const callTool = vi.fn(async (_name: string, params: Record<string, unknown>) => {
      if (params.index === 1) f.manager.writePauseSentinel();
      return result(Number(params.index));
    });
    expect(await runCommand(f.input, f.io, { workflowToolCaller: { callTool } })).toBe(0);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(f.manager.readState().run_status).toBe('paused');
  });
});
