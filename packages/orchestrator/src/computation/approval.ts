import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, type ApprovalPacketV1 } from '@nullius/shared';
import { StateManager } from '../state-manager.js';
import { utcNowIso } from '../util.js';
import { executionBinding } from './execution-binding.js';
import { assertExecutionPlanValid } from './execution-plan.js';
import { ensureDir, sha256Text, toPosixRelative, writeJsonAtomic, writeTextAtomic } from './io.js';
import type { ApprovalRequiredExecutionResult, PreparedManifest } from './types.js';

function previewApprovalId(current: number): string {
  return `A3-${String(current + 1).padStart(4, '0')}`;
}

function approvalArtifacts(projectRoot: string, runId: string, approvalId: string) {
  const approvalDir = path.join(projectRoot, 'artifacts', 'runs', runId, 'approvals', approvalId);
  return {
    approvalDir,
    packetPath: path.join(approvalDir, 'packet_short.md'),
    packetJsonPath: path.join(approvalDir, 'approval_packet_v1.json'),
    packetFullPath: path.join(approvalDir, 'packet.md'),
  };
}

function bridgeDetails(prepared: PreparedManifest): string {
  const planPath = path.join(prepared.workspaceDir, 'execution_plan_v1.json');
  if (!fs.existsSync(planPath)) {
    return `Workspace: ${prepared.workspaceDir}\n\nContainment: validated within current run directory.`;
  }
  const executionPlan = assertExecutionPlanValid(
    JSON.parse(fs.readFileSync(planPath, 'utf-8')) as unknown,
  );
  const observables = executionPlan.source.required_observables?.join(', ') ?? 'none recorded';
  const executionSurfaceNote = executionPlan.source.method_spec_present
    ? 'Execution surface: provider-backed manifest materialized from the staged method bundle.'
    : 'Execution surface: the explicit manifest and its listed commands define the operation; planning metadata alone grants no execution authority.';
  const taskLines = executionPlan.tasks.map(task => {
    const artifacts = task.expected_artifacts.map(artifact => artifact.path).join(', ');
    return `- ${task.task_id}: ${task.title} [capabilities: ${task.capabilities.join(', ')}] -> ${artifacts}`;
  }).join('\n');
  return [
    `Workspace: ${prepared.workspaceDir}`,
    '',
    'Containment: validated within current run directory.',
    '',
    `Bridge objective: ${executionPlan.objective}`,
    `Source handoff: ${executionPlan.source.source_handoff_uri}`,
    `Required observables: ${observables}`,
    executionSurfaceNote,
    '',
    'Execution plan tasks:',
    taskLines,
  ].join('\n');
}

function buildApprovalPacket(projectRoot: string, prepared: PreparedManifest, requestedAt: string, approvalId: string): ApprovalPacketV1 {
  // The manifest preflight executes between approval and the first step, so
  // the packet must list it — an approved run must never execute a command
  // the approver did not see.
  const preflight = (prepared.manifest as { preflight?: string[] }).preflight;
  const commands = [
    ...(preflight && preflight.length > 0
      ? [`[preflight] ${preflight.map(part => part.split('{entry}').join(prepared.entryPointScriptPath)).join(' ')}`]
      : []),
    ...prepared.steps.map(step => step.argv.join(' ')),
  ];
  const outputs = prepared.topLevelOutputs.length > 0
    ? prepared.topLevelOutputs
    : prepared.steps.flatMap(step => step.expectedOutputs.map(output => `computation/${output}`));
  return {
    schema_version: 1,
    approval_id: approvalId,
    gate_id: 'A3',
    run_id: prepared.runId,
    workflow_id: 'computation',
    purpose: `Authorize execution of ${prepared.manifestRelativePath} for run ${prepared.runId}.`,
    plan: prepared.stepOrder.map(stepId => {
      const step = prepared.steps.find(candidate => candidate.id === stepId)!;
      return `${step.id}: ${step.tool} ${step.scriptRelativePath}`;
    }),
    risks: [
      'Project-local scripts will be executed within the run workspace.',
      'Declared outputs are enforced fail-closed; missing outputs mark the run failed.',
      prepared.manifest.description?.includes('Provider-backed execution materialized from staged method_spec.run_card')
        ? 'Execution authority comes from the staged method bundle; review the materialized provider-backed manifest rather than inferring missing runtime steps.'
        : 'Execution authority comes from the explicit run-local manifest; review its commands and supplied scripts before approving.',
    ],
    budgets: {
      ...(prepared.manifest.computation_budget?.max_runtime_minutes !== undefined
        ? { max_runtime_minutes: prepared.manifest.computation_budget.max_runtime_minutes }
        : {}),

    },
    outputs,
    rollback: `Reject approval or remove outputs under ${toPosixRelative(prepared.runDir, prepared.workspaceDir)}.`,
    commands,
    checklist: [
      'Verify the execution scope is limited to the current run workspace.',
      'Confirm the expected outputs and resource budget are acceptable.',
      'Confirm the materialized manifest fully captures the execution authority you intend to approve; do not infer missing provider logic outside the checked-in run workspace.',
    ],
    requested_at: requestedAt,
    run_card_path: prepared.manifestRelativePath,
    run_card_sha256: prepared.manifestSha256,
    execution_binding: executionBinding(projectRoot, prepared),
    plan_step_ids: prepared.stepOrder,
    details_md: bridgeDetails(prepared),
  };
}

function writeApprovalPacketArtifacts(projectRoot: string, prepared: PreparedManifest, approvalId: string): {
  packetPath: string;
  packetJsonPath: string;
  packetSha256: string;
  commit: () => void;
} {
  const requestedAt = utcNowIso();
  const packet = buildApprovalPacket(projectRoot, prepared, requestedAt, approvalId);
  const artifacts = approvalArtifacts(projectRoot, prepared.runId, approvalId);
  const packetJsonText = JSON.stringify(packet, null, 2) + '\n';
  return {
    packetPath: toPosixRelative(projectRoot, artifacts.packetPath),
    packetJsonPath: toPosixRelative(projectRoot, artifacts.packetJsonPath),
    packetSha256: sha256Text(packetJsonText),
    commit: () => {
      ensureDir(artifacts.approvalDir);
  writeTextAtomic(
    artifacts.packetPath,
    `# Approval: ${approvalId} (A3)\n\nRun: ${prepared.runId}\nManifest: ${prepared.manifestRelativePath}\nRequested: ${requestedAt}\n`,
  );
  writeTextAtomic(
    artifacts.packetFullPath,
    `# Approval packet — ${approvalId} (A3)\n\n${packet.purpose}\n\n## Commands\n${packet.commands.map(command => `- ${command}`).join('\n')}\n`,
  );
  writeJsonAtomic(artifacts.packetJsonPath, packet);
    },
  };
}

export function ensureA3Approval(
  projectRoot: string,
  prepared: PreparedManifest,
): ApprovalRequiredExecutionResult | null {
  const stateManager = new StateManager(projectRoot);
  const state = stateManager.readState();
  if (state.run_id !== prepared.runId) {
    throw invalidParams('orchestrator run_id does not match execution run_id', {
      orchestrator_run_id: state.run_id,
      execution_run_id: prepared.runId,
      next_actions: [{ tool: 'orch_run_create', args: { project_root: projectRoot, run_id: prepared.runId, workflow_id: 'computation' } }],
    });
  }
  // A3 (compute_runs) is opt-in: only machine-gate compute when the policy explicitly
  // enables it (default off — interactive use needs no pause; unattended runs opt in).
  if (state.pending_approval && state.pending_approval.category !== 'A3') throw invalidParams('another root approval is pending; resolve it before computing');
  const previousA3Authority = state.approval_history.some(entry => entry.category === 'A3' && entry.decision === 'approved');
  if (stateManager.readPolicy().require_approval_for?.compute_runs !== true && !previousA3Authority && state.pending_approval?.category !== 'A3') {
    return null;
  }
  const binding = executionBinding(projectRoot, prepared);
  const matchesPacket = (approvalId: string, expectedHash: string | undefined): boolean => {
    try {
      const bytes = fs.readFileSync(approvalArtifacts(projectRoot, prepared.runId, approvalId).packetJsonPath, 'utf-8');
      const packet = JSON.parse(bytes);
      return Boolean(expectedHash && sha256Text(bytes) === expectedHash && packet.run_id === prepared.runId
        && packet.execution_binding?.sha256 === binding.sha256);
    } catch { return false; }
  };
  const satisfiedA3 = typeof state.gate_satisfied.A3 === 'string' ? state.gate_satisfied.A3 : null;
  const approved = [...state.approval_history].reverse().find(entry => entry.category === 'A3' && entry.approval_id === satisfiedA3 && entry.decision === 'approved');
  if (satisfiedA3 && matchesPacket(satisfiedA3, approved?.packet_sha256)) return null;
  const pending = state.pending_approval;
  if (pending?.category === 'A3' && matchesPacket(pending.approval_id, pending.packet_sha256)) {
    const artifacts = approvalArtifacts(projectRoot, prepared.runId, pending.approval_id);
    return { status: 'requires_approval', requires_approval: true, gate_id: 'A3', run_id: prepared.runId,
      approval_id: pending.approval_id, approval_packet_sha256: pending.packet_sha256!, packet_path: pending.packet_path,
      packet_json_path: toPosixRelative(projectRoot, artifacts.packetJsonPath), message: `Approval required: ${pending.approval_id}` };
  }
  if (pending && pending.category !== 'A3') throw invalidParams('another root approval is pending; resolve it before computing');
  delete state.gate_satisfied.A3;
  const approvalId = previewApprovalId(state.approval_seq.A3 ?? 0);
  const packet = writeApprovalPacketArtifacts(projectRoot, prepared, approvalId);
  const packetPath = packet.packetPath;
  const returnedApprovalId = stateManager.requestApproval(state, 'A3', { packet_path: packetPath, packet_sha256: packet.packetSha256, replace_pending: pending?.category === 'A3', before_commit: packet.commit });
  if (returnedApprovalId !== approvalId) {
    throw invalidParams('approval_id drifted while creating A3 request', {
      expected: approvalId,
      actual: returnedApprovalId,
    });
  }
  return {
    status: 'requires_approval',
    requires_approval: true,
    gate_id: 'A3',
    run_id: prepared.runId,
    approval_id: approvalId,
    approval_packet_sha256: packet.packetSha256,
    packet_path: packet.packetPath,
    packet_json_path: packet.packetJsonPath,
    message: `Approval required: ${approvalId}`,
  };
}

export function hasBoundA3Approval(projectRoot: string, prepared: PreparedManifest): boolean {
  const state = new StateManager(projectRoot).readState();
  const id = state.gate_satisfied.A3;
  const approved = [...state.approval_history].reverse().find(entry => entry.category === 'A3' && entry.approval_id === id && entry.decision === 'approved');
  if (typeof id !== 'string' || !approved?.packet_sha256) return false;
  try {
    const bytes = fs.readFileSync(approvalArtifacts(projectRoot,prepared.runId,id).packetJsonPath,'utf-8');
    const packet = JSON.parse(bytes);
    return sha256Text(bytes) === approved.packet_sha256 && packet.run_id === prepared.runId
      && packet.execution_binding?.sha256 === executionBinding(projectRoot,prepared).sha256;
  } catch {return false;}
}
