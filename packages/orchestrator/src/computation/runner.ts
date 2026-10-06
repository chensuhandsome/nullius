import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureA3Approval, hasBoundA3Approval } from './approval.js';
import { prepareManifest } from './manifest.js';
import { executionBinding, preparedPreflight } from './execution-binding.js';
import { assertNativeEntry, nativePauseRequested, nativeDeadlineExpired } from './native-control.js';
import { invalidParams, writeBytesAtomicDurable } from '@nullius/shared';
import { StateManager } from '../state-manager.js';
import { maybeQueueIdeaEngineComputationFeedback } from './idea-engine-feedback.js';
import { maybeGenerateSkillProposal } from './skill-proposal-genesis.js';
import { maybeGenerateOpportunityProposals } from './opportunity-proposal-genesis.js';
import { utcNowIso } from '../util.js';
import { ensureDir, sha256File, toPosixRelative, writeJsonAtomic } from './io.js';
import { recordComputationResultToMemoryGraph } from './memory-graph-hookup.js';
import { writeComputationResultArtifact } from './result.js';
import { assertDeclaredDependencyClosure, assertStepPathArgumentsDeclared } from './dependency-closure.js';
import { assertNoSymlinkComponents, resolveWithinRoot } from './path-safety.js';
import { assertNativeRuntimeIdentityLive } from './runtime-identity.js';
import type {
  CompletedExecutionResult,
  PausedExecutionResult,
  ApprovalRequiredExecutionResult,
  ExternalDependencySnapshotEntry,
  ExecutionStatusFile,
  FailedExecutionResult,
  PreparedManifest,
  StepExecutionSnapshotV1,
  StepCommandPlan,
  WorkspaceFileSnapshotEntry,
} from './types.js';

function generatedProposal<T extends { proposalPath: string }>(
  proposal: T | { suppressed: true; proposalFingerprint: string; decision: string } | null,
): proposal is T {
  return Boolean(proposal && 'proposalPath' in proposal);
}

function buildStatus(prepared: PreparedManifest): ExecutionStatusFile {
  return {
    schema_version: 1,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    status: 'running',
    deadline_at: null,
    execution_binding_sha256: '',
    active_child: null,
    started_at: utcNowIso(),
    completed_at: null,
    errors: [],
    entry_point: {
      script: prepared.entryPointScriptRelativePath,
      sha256: sha256File(prepared.entryPointScriptPath),
    },
    steps: prepared.steps.map(step => ({
      id: step.id,
      tool: step.tool,
      command: step.argv,
      runtime_identity: step.runtimeIdentity,
      execution_environment: step.executionEnvironment,
      script: step.scriptRelativePath,
      script_pre_sha256: sha256File(step.scriptPath),
      script_post_sha256: null,
      expected_outputs: step.expectedOutputs,
      pre_snapshot_path: `logs/${step.id}/pre_snapshot_v1.json`,
      pre_snapshot_sha256: null,
      post_snapshot_path: `logs/${step.id}/post_snapshot_v1.json`,
      post_snapshot_sha256: null,
      output_refs: [],
      status: 'pending',
      skip_reason: null,
      exit_code: null,
      started_at: null,
      completed_at: null,
      log_dir: '',
    })),
  };
}

function snapshotWorkspaceFile(workspaceDir: string, filePath: string): WorkspaceFileSnapshotEntry {
  assertNoSymlinkComponents(workspaceDir, filePath, 'workspace snapshot file');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`workspace snapshot target is not a regular file: ${filePath}`);
  const bytes = fs.readFileSync(filePath);
  return {
    relative_path: toPosixRelative(workspaceDir, filePath),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
}

function listWorkspaceSnapshotEntries(params: {
  logsDir: string;
  statusPath: string;
  workspaceDir: string;
}): WorkspaceFileSnapshotEntry[] {
  const entries: WorkspaceFileSnapshotEntry[] = [];
  const walk = (dirPath: string): void => {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(dirPath, entry.name);
      if (fullPath === params.logsDir || fullPath === params.statusPath) continue;
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`workspace snapshot refuses symbolic link: ${fullPath}`);
      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (stat.isFile()) {
        entries.push(snapshotWorkspaceFile(params.workspaceDir, fullPath));
      } else {
        throw new Error(`workspace snapshot refuses non-regular filesystem entry: ${fullPath}`);
      }
    }
  };
  walk(params.workspaceDir);
  return entries.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
}

function externalDependencySnapshotEntries(prepared: PreparedManifest): ExternalDependencySnapshotEntry[] {
  const dependencies = prepared.manifest.dependencies as Record<string, unknown>;
  const refs = Array.isArray(dependencies.external_dependency_refs)
    ? dependencies.external_dependency_refs as Array<Record<string, unknown>>
    : [];
  return refs.map((ref, index) => {
    if (typeof ref.path !== 'string' || typeof ref.sha256 !== 'string') {
      throw new Error(`external_dependency_refs[${index}] must contain path and sha256`);
    }
    if (!path.isAbsolute(ref.path)) {
      throw new Error(`external_dependency_refs[${index}].path must be absolute and must not depend on the caller working directory`);
    }
    const canonicalPath = fs.realpathSync.native(ref.path);
    if (!fs.lstatSync(canonicalPath).isFile()) {
      throw new Error(`external dependency is not a regular file: ${ref.path}`);
    }
    const bytes = fs.readFileSync(canonicalPath);
    const actual = sha256File(canonicalPath);
    if (actual !== ref.sha256) {
      throw new Error(`external dependency hash mismatch: ${ref.path}`);
    }
    if (ref.size_bytes !== undefined && ref.size_bytes !== bytes.length) {
      throw new Error(`external dependency size mismatch: ${ref.path}`);
    }
    return { canonical_path: canonicalPath, sha256: actual, size_bytes: bytes.length };
  }).sort((left, right) => left.canonical_path.localeCompare(right.canonical_path));
}

function assertWorkspaceRefsLive(workspaceDir: string, refs: WorkspaceFileSnapshotEntry[], label: string): void {
  for (const ref of refs) {
    const filePath = resolveWithinRoot(workspaceDir, ref.relative_path, label);
    assertNoSymlinkComponents(workspaceDir, filePath, label);
    if (!fs.existsSync(filePath) || !fs.lstatSync(filePath).isFile()) {
      throw new Error(`${label} is missing: ${ref.relative_path}`);
    }
    const bytes = fs.readFileSync(filePath);
    if (bytes.length !== ref.size_bytes || sha256File(filePath) !== ref.sha256) {
      throw new Error(`${label} changed: ${ref.relative_path}`);
    }
  }
}

function requireNonEmptyWorkspaceRefs(
  refs: WorkspaceFileSnapshotEntry[],
  label: string,
): [WorkspaceFileSnapshotEntry, ...WorkspaceFileSnapshotEntry[]] {
  if (refs.length === 0) throw new Error(`${label} must contain at least one workspace file`);
  return refs as [WorkspaceFileSnapshotEntry, ...WorkspaceFileSnapshotEntry[]];
}

function assertExternalRefsLive(refs: ExternalDependencySnapshotEntry[], label: string): void {
  for (const ref of refs) {
    if (!fs.existsSync(ref.canonical_path) || !fs.lstatSync(ref.canonical_path).isFile()) {
      throw new Error(`${label} is missing: ${ref.canonical_path}`);
    }
    const bytes = fs.readFileSync(ref.canonical_path);
    if (bytes.length !== ref.size_bytes || sha256File(ref.canonical_path) !== ref.sha256) {
      throw new Error(`${label} changed: ${ref.canonical_path}`);
    }
  }
}

function priorOutputRefs(status: ExecutionStatusFile, currentStepId?: string): WorkspaceFileSnapshotEntry[] {
  return status.steps
    .filter(step => step.id !== currentStepId && step.status === 'completed')
    .flatMap(step => step.output_refs);
}

function writeExecutionSnapshot(filePath: string, snapshot: StepExecutionSnapshotV1): string {
  writeJsonAtomic(filePath, snapshot);
  return sha256File(filePath);
}

function assertPreparedExecutionBinding(prepared: PreparedManifest): void {
  const entryMatches = prepared.steps.filter(
    step => step.scriptRelativePath === prepared.entryPointScriptRelativePath,
  );
  if (entryMatches.length !== 1) {
    throw new Error(
      `entry_point.script must identify exactly one executed manifest step; found ${entryMatches.length}`,
    );
  }
  const entryStep = entryMatches[0]!;
  const declaredEntryArgs = prepared.manifest.entry_point.args ?? [];
  const stepArgs = prepared.manifest.steps.find(step => step.id === entryStep.id)?.args ?? [];
  if (
    (prepared.manifest.entry_point.tool !== undefined && prepared.manifest.entry_point.tool !== entryStep.tool)
    || declaredEntryArgs.length !== stepArgs.length
    || declaredEntryArgs.some((value, index) => value !== stepArgs[index])
  ) {
    throw new Error('entry_point must match the unique executed step tool and arguments exactly');
  }
  if (sha256File(prepared.manifestPath) !== prepared.manifestSha256) {
    throw new Error('computation manifest changed after preparation and before execution');
  }
}

function syntheticIntegrityFailureOutput(message: string): ReturnType<typeof spawnSync> {
  return {
    pid: 0,
    output: [null, '', message],
    stdout: '',
    stderr: message,
    status: null,
    signal: null,
    error: undefined,
  } as ReturnType<typeof spawnSync>;
}

function writeStepLogs(
  logDir: string,
  step: StepCommandPlan,
  output: ReturnType<typeof spawnSync>,
  snapshotMeta: Record<string, unknown>,
): void {
  ensureDir(logDir);
  // stdout/stderr capture must survive crash before the next CLI re-read
  // (status --json reads these on resume to surface failure context).
  writeBytesAtomicDurable(path.join(logDir, 'stdout.txt'), output.stdout ?? '');
  writeBytesAtomicDurable(path.join(logDir, 'stderr.txt'), output.stderr ?? '');
  writeJsonAtomic(path.join(logDir, 'meta.json'), {
    command: step.argv,
    exit_code: output.status,
    signal: output.signal,
    error: output.error?.message ?? null,
    runtime_identity: step.runtimeIdentity,
    execution_environment: step.executionEnvironment,
    ...snapshotMeta,
  });
}

export async function runPreparedManifest(
  projectRoot: string,
  prepared: PreparedManifest,
  beforeSteps?: () => void,
): Promise<CompletedExecutionResult | FailedExecutionResult | PausedExecutionResult | ApprovalRequiredExecutionResult> {
  assertNativeEntry(projectRoot, prepared.runId, prepared.workspaceDir);
  const expired = nativeDeadlineExpired(prepared.workspaceDir);
  const admissionApproval = expired ? null : ensureA3Approval(projectRoot, prepareManifest({ projectRoot, runId: prepared.runId, runDir: prepared.runDir, manifestPath: prepared.manifestPath }));
  if (admissionApproval) return admissionApproval;
  if (!expired) assertPreparedExecutionBinding(prepared);
  const stateManager = new StateManager(projectRoot);
  const logsDir = path.join(prepared.workspaceDir, 'logs');
  const statusPath = path.join(prepared.workspaceDir, 'execution_status.json');
  const previous = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf-8')) as ExecutionStatusFile : null;
  const preflight = expired ? null : preparedPreflight(prepared);
  if (!preflight && !expired) {
    const freshPrepared = prepareManifest({ projectRoot, runId: prepared.runId, runDir: prepared.runDir, manifestPath: prepared.manifestPath });
    const approval = ensureA3Approval(projectRoot, freshPrepared);
    if (approval) return approval;
    if (nativePauseRequested(stateManager, prepared.runId)) throw new Error('paused native computation: continuation in place is unsupported');
    // Inspect the previous attempt before replacing its terminal status.
    // With no preflight child, capture still precedes the first status write.
    beforeSteps?.();
  }
  const status = expired && previous ? previous : buildStatus(prepared);
  const budget = prepared.manifest.computation_budget?.max_runtime_minutes;
  if (previous && previous.run_id !== prepared.runId) throw new Error('execution status run identity mismatch');
  if (previous && budget !== undefined && (!Object.hasOwn(previous, 'deadline_at') || previous.deadline_at === null)) throw new Error('existing native status has no anchored deadline; use a fresh run');
  status.started_at = previous?.started_at ?? status.started_at;
  status.deadline_at = previous ? previous.deadline_at ?? null : budget === undefined ? null : new Date(Date.now() + budget * 60_000).toISOString();
  if (status.deadline_at && !Number.isFinite(Date.parse(status.deadline_at))) throw new Error('invalid persisted native deadline');
  if (!expired) status.execution_binding_sha256 = executionBinding(projectRoot, prepared).sha256;
  const initialState = stateManager.readState();
  if (nativePauseRequested(stateManager, prepared.runId)) throw new Error('paused native computation: continuation in place is unsupported');
  // Admitted terminal re-execution is a new dispatch within the same persisted deadline.
  // Paused attempts were refused before this point and never enter this path.
  if (initialState.run_status === 'completed' || initialState.run_status === 'failed') initialState.run_status = 'running';
  initialState.artifacts.native_execution_status = toPosixRelative(projectRoot, statusPath);
  stateManager.saveState(initialState);
  writeJsonAtomic(statusPath, status);
  const finalizePausedRun = (): PausedExecutionResult => {
    const fresh = stateManager.readState();
    if (fresh.run_id !== prepared.runId) throw new Error('native execution identity changed during pause');
    if (fresh.run_status !== 'paused') stateManager.pauseRun(fresh, 'native pause observed after current child returned');
    status.active_child = null;
    status.status = 'paused'; status.continuation_supported = false;
    status.completed_at = null;
    writeJsonAtomic(statusPath, status);
    return { status: 'paused', run_id: prepared.runId, continuation_supported: false,
      message: 'Paused; native continuation in place is unsupported. Create a separately approved fresh run.',
      artifact_paths: { execution_status: statusPath, logs_dir: logsDir },
      produced_outputs: status.steps.flatMap(step => step.output_refs.map(ref => ref.relative_path)) };
  };
  const remaining = (): number | undefined => status.deadline_at ? Date.parse(status.deadline_at) - Date.now() : undefined;
  const childTimeout = (minutes: number | null, fallback?: number): number | undefined => {
    const limits = [remaining(), minutes === null ? fallback : minutes * 60_000].filter((value): value is number => value !== undefined);
    return limits.length ? Math.max(0, Math.ceil(Math.min(...limits))) : undefined;
  };
  const deadlineExpired = () => remaining() !== undefined && remaining()! <= 0;
  const approvalBeforeDispatch = (): ApprovalRequiredExecutionResult | null => {
    const freshPrepared = prepareManifest({ projectRoot, runId: prepared.runId, runDir: prepared.runDir, manifestPath: prepared.manifestPath });
    const approval = ensureA3Approval(projectRoot, freshPrepared);
    if (approval) { status.active_child = null; status.status = 'awaiting_approval'; writeJsonAtomic(statusPath, status); return approval; }
    if (executionBinding(projectRoot, freshPrepared).sha256 !== status.execution_binding_sha256) throw new Error('approved execution inputs changed after native execution started');
    return null;
  };
  const failedSteps = new Set<string>();
  const skippedSteps = new Set<string>();
  const finalizeFailedRun = async (
    failureReason: string,
    failedStepId: string,
  ): Promise<FailedExecutionResult | PausedExecutionResult> => {
    if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
    status.active_child = null;
    status.status = 'failed';
    status.completed_at = utcNowIso();
    writeJsonAtomic(statusPath, status);
    const failedState = stateManager.readState();
    if (failedState.run_status === 'running') {
      try {
        stateManager.transitionStatus(failedState, 'failed', {
          eventType: 'execution_failed',
          details: { run_id: prepared.runId, step_id: failedStepId, execution_status: statusPath },
        });
      } catch (error) {
        if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
        throw error;
      }
    }
    const { computationResult, computationResultPath, computationResultRef } = writeComputationResultArtifact({
      prepared,
      status,
      statusPath,
      logsDir,
      producedOutputs: prepared.steps.flatMap(currentStep => currentStep.expectedOutputPaths.filter(filePath => fs.existsSync(filePath))),
      failureReason,
    });
    maybeQueueIdeaEngineComputationFeedback({
      prepared,
      computationResult,
    });
    const memoryGraph = await recordComputationResultToMemoryGraph({
      projectRoot,
      manifest: prepared.manifest,
      computationResult,
    });
    if (memoryGraph.repairProposalPath) {
      const state = stateManager.readState();
      state.artifacts = {
        ...state.artifacts,
        mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
      };
      stateManager.saveStateWithLedger(state, 'repair_mutation_proposed', {
        details: {
          proposal_id: memoryGraph.repairProposalId,
          proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
        },
      });
    } else if (memoryGraph.repairProposalSuppressed) {
      stateManager.appendLedger('proposal_suppressed', {
        run_id: prepared.runId,
        workflow_id: 'computation',
        details: {
          proposal_kind: 'repair',
          proposal_fingerprint: memoryGraph.repairProposalFingerprint,
          suppression_decision: memoryGraph.repairSuppressionDecision,
        },
      });
    }
    const skillProposal = maybeGenerateSkillProposal({
      projectRoot,
      runId: prepared.runId,
      manifest: prepared.manifest,
      computationResult,
    });
    if (skillProposal && !skillProposal.suppressed) {
      const state = stateManager.readState();
      state.artifacts = {
        ...state.artifacts,
        skill_proposal_v2: toPosixRelative(projectRoot, skillProposal.proposalPath),
      };
      stateManager.saveStateWithLedger(state, 'skill_proposal_generated', {
        details: {
          proposal_id: skillProposal.proposal.proposal_id,
          proposal_path: toPosixRelative(projectRoot, skillProposal.proposalPath),
        },
      });
    } else if (skillProposal?.suppressed) {
      stateManager.appendLedger('proposal_suppressed', {
        run_id: prepared.runId,
        workflow_id: 'computation',
        details: {
          proposal_kind: 'skill',
          proposal_fingerprint: skillProposal.proposalFingerprint,
          suppression_decision: skillProposal.decision,
        },
      });
    }
    const opportunityProposals = maybeGenerateOpportunityProposals({
      projectRoot,
      runId: prepared.runId,
      manifest: prepared.manifest,
      computationResult,
    });
    if (opportunityProposals.optimize || opportunityProposals.innovate) {
      const state = stateManager.readState();
      state.artifacts = {
        ...state.artifacts,
        ...(generatedProposal(opportunityProposals.optimize) ? { mutation_proposal_optimize_v1: toPosixRelative(projectRoot, opportunityProposals.optimize.proposalPath) } : {}),
        ...(generatedProposal(opportunityProposals.innovate) ? { mutation_proposal_innovate_v1: toPosixRelative(projectRoot, opportunityProposals.innovate.proposalPath) } : {}),
      };
      stateManager.saveStateWithLedger(state, 'opportunity_proposals_recorded');
      for (const [proposalKind, proposal] of [['optimize', opportunityProposals.optimize], ['innovate', opportunityProposals.innovate]] as const) {
        if (proposal && !('proposalPath' in proposal)) {
          stateManager.appendLedger('proposal_suppressed', {
            run_id: prepared.runId,
            workflow_id: 'computation',
            details: {
              proposal_kind: proposalKind,
              proposal_fingerprint: proposal.proposalFingerprint,
              suppression_decision: proposal.decision,
            },
          });
        }
      }
    }
    return {
      status: 'failed',
      ok: false,
      run_id: prepared.runId,
      manifest_path: prepared.manifestRelativePath,
      manifest_sha256: prepared.manifestSha256,
      artifact_paths: {
        execution_status: statusPath,
        logs_dir: logsDir,
        computation_result: computationResultPath,
      },
      outcome_ref: computationResultRef,
      next_actions: computationResult.next_actions,
      followup_bridge_refs: computationResult.followup_bridge_refs,
      summary: computationResult.summary,
      errors: [...status.errors],
    };
  };
  if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
  if (deadlineExpired()) { status.errors.push('native whole-run deadline expired before dispatch'); return finalizeFailedRun(status.errors.at(-1)!, 'preflight'); }
  if (preflight) {
    if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
    status.active_child = { kind: 'preflight', id: 'preflight' }; writeJsonAtomic(statusPath, status);
    const approval = approvalBeforeDispatch(); if (approval) return approval;
    if (nativePauseRequested(stateManager, prepared.runId)) { status.active_child = null; return finalizePausedRun(); }
    const timeout = childTimeout(preflight.stepLimitMinutes, 300_000);
    if (timeout === 0 || deadlineExpired()) { status.active_child = null; status.errors.push('native whole-run deadline expired before preflight child'); return finalizeFailedRun(status.errors.at(-1)!, 'preflight'); }
    const output = spawnSync(preflight.argv[0]!, preflight.argv.slice(1), { cwd: prepared.workspaceDir, encoding: 'utf-8', env: preflight.environment.variables, timeout });
    status.active_child = null; writeJsonAtomic(statusPath, status);
    const logDir = path.join(logsDir, 'preflight'); ensureDir(logDir);
    writeBytesAtomicDurable(path.join(logDir, 'stdout.txt'), output.stdout ?? '');
    writeBytesAtomicDurable(path.join(logDir, 'stderr.txt'), output.stderr ?? '');
    writeJsonAtomic(path.join(logDir, 'meta.json'), { command: preflight.argv, exit_code: output.status, error: output.error?.message ?? null });
    if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
    if (deadlineExpired()) { status.errors.push('native whole-run deadline expired during preflight'); return finalizeFailedRun(status.errors.at(-1)!, 'preflight'); }
    if (output.error || output.status !== 0) {
      status.status = 'failed'; status.completed_at = utcNowIso(); status.errors.push('manifest preflight refused the entry source'); writeJsonAtomic(statusPath, status);
      throw invalidParams(`manifest preflight refused the entry source (exit ${output.status ?? 'spawn-error'}): ${output.error?.message ?? output.stderr}`, { validation_layer: 'preflight', preflight: preflight.argv });
    }
  }
  if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
  if (preflight) beforeSteps?.();
  for (const stepId of prepared.stepOrder) {
    if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
    if (deadlineExpired()) { status.errors.push('native whole-run deadline expired before next dispatch'); return finalizeFailedRun(status.errors.at(-1)!, stepId); }
    const approval = approvalBeforeDispatch(); if (approval) return approval;
    const step = prepared.steps.find(candidate => candidate.id === stepId)!;
    const statusStep = status.steps.find(candidate => candidate.id === stepId)!;
    const logDir = path.join(logsDir, stepId);
    const blockedOn = (prepared.manifest.steps.find(candidate => candidate.id === stepId)?.depends_on ?? [])
      .filter(dependency => failedSteps.has(dependency) || skippedSteps.has(dependency));
    if (blockedOn.length > 0) {
      // Only reachable under on_failure=continue (fail-fast returns at the
      // first failure): a dependent of a failed or skipped step is skipped,
      // recorded as such, and never counted as its own failure.
      statusStep.status = 'skipped';
      statusStep.skip_reason = `dependency did not complete: ${blockedOn.join(', ')}`;
      statusStep.completed_at = utcNowIso();
      skippedSteps.add(step.id);
      writeJsonAtomic(statusPath, status);
      continue;
    }
    statusStep.status = 'running';
    statusStep.started_at = utcNowIso();
    statusStep.log_dir = toPosixRelative(prepared.workspaceDir, logDir);
    writeJsonAtomic(statusPath, status);
    let integrityFailure: string | null = null;
    if (step.gates.length > 0) {
      // Step gates are a binding check against approvals already recorded in
      // the orchestrator state — never a request flow: an unsatisfied gate
      // fails the step closed instead of minting an approval packet.
      const gateState = stateManager.readState();
      const unsatisfiedGates = step.gates.filter(
        gateId => typeof gateState.gate_satisfied[gateId] !== 'string' || (gateId === 'A3' && !hasBoundA3Approval(projectRoot, prepared)),
      );
      if (unsatisfiedGates.length > 0) {
        integrityFailure = `step '${step.id}' requires unsatisfied approval gate(s): ${unsatisfiedGates.join(', ')} — record the approval(s) before re-running`;
      }
    }
    let liveManifestHash = '';
    let liveScriptHash = '';
    let workspaceRefs: WorkspaceFileSnapshotEntry[] = [];
    let externalRefs: ExternalDependencySnapshotEntry[] = [];
    const preSnapshotPath = path.join(logDir, 'pre_snapshot_v1.json');
    const postSnapshotPath = path.join(logDir, 'post_snapshot_v1.json');
    ensureDir(logDir);
    if (!integrityFailure) try {
      assertNativeRuntimeIdentityLive({
        identity: step.runtimeIdentity,
        projectRoot,
        runDir: prepared.runDir,
      });
      assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status, step.id), 'prior step output before spawn');
      for (const outputPath of step.expectedOutputPaths) {
        assertNoSymlinkComponents(prepared.workspaceDir, outputPath, `step '${step.id}' output`, { allowMissingLeaf: true });
        if (fs.existsSync(outputPath)) {
          throw new Error(`step '${step.id}' expected output existed before spawn: ${toPosixRelative(prepared.workspaceDir, outputPath)}`);
        }
      }
      liveManifestHash = sha256File(prepared.manifestPath);
      liveScriptHash = sha256File(step.scriptPath);
      workspaceRefs = listWorkspaceSnapshotEntries({
        logsDir,
        statusPath,
        workspaceDir: prepared.workspaceDir,
      });
      externalRefs = externalDependencySnapshotEntries(prepared);
      assertWorkspaceRefsLive(prepared.workspaceDir, workspaceRefs, `step '${step.id}' pre-spawn workspace snapshot`);
      assertExternalRefsLive(externalRefs, `step '${step.id}' pre-spawn external dependency`);
      assertDeclaredDependencyClosure({
        externalRefs,
        manifest: prepared.manifest,
        workspaceDir: prepared.workspaceDir,
        workspaceRefs,
      });
      assertStepPathArgumentsDeclared({
        externalRefs,
        manifest: prepared.manifest,
        workspaceDir: prepared.workspaceDir,
      });
      const manifestRelativePath = toPosixRelative(prepared.workspaceDir, prepared.manifestPath);
      const scriptRelativePath = toPosixRelative(prepared.workspaceDir, step.scriptPath);
      const manifestRef = workspaceRefs.find(ref => ref.relative_path === manifestRelativePath);
      const scriptRef = workspaceRefs.find(ref => ref.relative_path === scriptRelativePath);
      if (!manifestRef || !scriptRef) {
        throw new Error(`step '${step.id}' pre-spawn snapshot omitted manifest or script`);
      }
      const preSnapshot: StepExecutionSnapshotV1 = {
        schema_version: 1,
        phase: 'pre_spawn',
        step_id: step.id,
        captured_at: utcNowIso(),
        manifest_ref: manifestRef,
        script_ref: scriptRef,
        runtime_identity: step.runtimeIdentity,
        execution_environment: step.executionEnvironment,
        workspace_file_refs: requireNonEmptyWorkspaceRefs(
          workspaceRefs,
          `step '${step.id}' pre-spawn snapshot`,
        ),
        external_dependency_refs: externalRefs,
        external_dependency_closure: 'declared_and_locked_not_syscall_traced',
      };
      statusStep.pre_snapshot_sha256 = writeExecutionSnapshot(preSnapshotPath, preSnapshot);
      writeJsonAtomic(statusPath, status);
    } catch (error) {
      integrityFailure = `pre-spawn provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!integrityFailure && liveManifestHash !== prepared.manifestSha256) {
      integrityFailure = `manifest changed before step '${step.id}' was spawned`;
    } else if (!integrityFailure && liveScriptHash !== statusStep.script_pre_sha256) {
      integrityFailure = `script for step '${step.id}' changed after the execution plan was recorded`;
    } else if (!integrityFailure && (statusStep.command.length !== step.argv.length || statusStep.command.some((value, index) => value !== step.argv[index]))) {
      integrityFailure = `structured command for step '${step.id}' changed after the execution plan was recorded`;
    }
    if (!integrityFailure) {
      if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
      if (deadlineExpired()) { status.errors.push('native whole-run deadline expired before child'); return finalizeFailedRun(status.errors.at(-1)!, step.id); }
      // Finish local writes before revalidating the authority and inputs that
      // authorize this child. A status writer can observe and revoke approval.
      status.active_child = { kind: 'step', id: step.id }; writeJsonAtomic(statusPath, status);
      const dispatchApproval = approvalBeforeDispatch(); if (dispatchApproval) return dispatchApproval;
      const liveGates = stateManager.readState();
      if (step.gates.some(gate => typeof liveGates.gate_satisfied[gate] !== 'string' || (gate === 'A3' && !hasBoundA3Approval(projectRoot, prepared)))) {
        statusStep.status = 'failed'; statusStep.completed_at = utcNowIso();
        status.errors.push(`step '${step.id}' approval gate changed before child`);
        return finalizeFailedRun(status.errors.at(-1)!, step.id);
      }
    }
    if (!integrityFailure && nativePauseRequested(stateManager, prepared.runId)) { status.active_child = null; return finalizePausedRun(); }
    const timeout = integrityFailure ? undefined : childTimeout(step.timeoutMinutes);
    if (!integrityFailure && (timeout === 0 || deadlineExpired())) { status.active_child = null; status.errors.push('native whole-run deadline expired before child dispatch'); return finalizeFailedRun(status.errors.at(-1)!, step.id); }
    const output = integrityFailure
      ? syntheticIntegrityFailureOutput(integrityFailure)
      : spawnSync(step.argv[0]!, step.argv.slice(1), {
        cwd: prepared.workspaceDir,
        encoding: 'utf-8',
        env: step.executionEnvironment.variables,
        timeout,
      });
    status.active_child = null;
    if (!integrityFailure) {
      try {
        assertNativeRuntimeIdentityLive({
          identity: step.runtimeIdentity,
          projectRoot,
          runDir: prepared.runDir,
        });
        const postManifestHash = sha256File(prepared.manifestPath);
        const postScriptHash = sha256File(step.scriptPath);
        if (postManifestHash !== liveManifestHash) {
          integrityFailure = `manifest changed while step '${step.id}' was executing`;
        } else if (postScriptHash !== liveScriptHash) {
          integrityFailure = `script for step '${step.id}' changed while it was executing`;
        }
        statusStep.script_post_sha256 = postScriptHash;
      } catch (error) {
        integrityFailure = `post-exit provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    statusStep.exit_code = output.status ?? null;
    statusStep.completed_at = utcNowIso();
    const missingOutputs = step.expectedOutputPaths.filter(filePath => !fs.existsSync(filePath));
    if (!integrityFailure && !output.error && output.status === 0 && missingOutputs.length === 0) {
      try {
        const outputRefs = step.expectedOutputPaths.map((filePath) => {
          assertNoSymlinkComponents(prepared.workspaceDir, filePath, `step '${step.id}' produced output`);
          return snapshotWorkspaceFile(prepared.workspaceDir, filePath);
        });
        assertWorkspaceRefsLive(
          prepared.workspaceDir,
          workspaceRefs,
          `step '${step.id}' pre-spawn inputs after exit`,
        );
        assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status, step.id), 'prior step output after current step');
        assertExternalRefsLive(externalRefs, `step '${step.id}' post-exit external dependency`);
        const manifestRef = snapshotWorkspaceFile(prepared.workspaceDir, prepared.manifestPath);
        const scriptRef = snapshotWorkspaceFile(prepared.workspaceDir, step.scriptPath);
        const postSnapshot: StepExecutionSnapshotV1 = {
          schema_version: 1,
          phase: 'post_exit',
          step_id: step.id,
          captured_at: utcNowIso(),
          manifest_ref: manifestRef,
          script_ref: scriptRef,
          runtime_identity: step.runtimeIdentity,
          execution_environment: step.executionEnvironment,
          workspace_file_refs: requireNonEmptyWorkspaceRefs(
            workspaceRefs,
            `step '${step.id}' post-exit snapshot`,
          ),
          external_dependency_refs: externalRefs,
          output_refs: outputRefs,
          external_dependency_closure: 'declared_and_locked_not_syscall_traced',
        };
        statusStep.output_refs = outputRefs;
        statusStep.post_snapshot_sha256 = writeExecutionSnapshot(postSnapshotPath, postSnapshot);
      } catch (error) {
        integrityFailure = `post-exit output provenance for step '${step.id}' failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    writeStepLogs(logDir, step, output, {
      pre_snapshot_path: statusStep.pre_snapshot_path,
      pre_snapshot_sha256: statusStep.pre_snapshot_sha256,
      post_snapshot_path: statusStep.post_snapshot_path,
      post_snapshot_sha256: statusStep.post_snapshot_sha256,
      script_pre_sha256: statusStep.script_pre_sha256,
      script_post_sha256: statusStep.script_post_sha256,
      output_refs: statusStep.output_refs,
    });
    if (integrityFailure || output.error || output.status !== 0 || missingOutputs.length > 0) {
      statusStep.status = 'failed';
      failedSteps.add(step.id);
      const failureReason = integrityFailure ?? output.error?.message
        ?? (output.status !== 0
          ? `step '${step.id}' exited with code ${output.status}`
          : `step '${step.id}' did not produce expected outputs: ${missingOutputs.map(filePath => toPosixRelative(prepared.runDir, filePath)).join(', ')}`);
      status.errors.push(failureReason);
      if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
      if (deadlineExpired()) { status.errors.push('native whole-run deadline expired during child'); return finalizeFailedRun(status.errors.at(-1)!, step.id); }
      if (prepared.onFailure === 'continue') {
        // on_failure=continue: persist the recorded failure and keep
        // executing steps whose dependencies all completed (their
        // dependents skip); the run still ends failed after the loop.
        writeJsonAtomic(statusPath, status);
        continue;
      }
      // Fail-fast keeps the single terminal write: the failed step, the
      // failed run status, and completed_at land in ONE atomic status
      // write inside finalizeFailedRun — a crash or concurrent reader must
      // never observe a failed step under a still-running run.
      return finalizeFailedRun(failureReason, step.id);
    }
    statusStep.status = 'completed';
    writeJsonAtomic(statusPath, status);
    if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
    if (deadlineExpired()) { status.errors.push('native whole-run deadline expired after child'); return finalizeFailedRun(status.errors.at(-1)!, step.id); }
  }
  if (failedSteps.size > 0) {
    // on_failure=continue reached the end of the sequence with recorded
    // failures: the overall execution is failed, with every error kept.
    // The aggregate reason joins status.errors exactly as each per-step
    // reason did before its finalize call on the fail-fast path.
    const aggregateReason = `${failedSteps.size} of ${prepared.stepOrder.length} step(s) failed under on_failure=continue: ${[...failedSteps].join(', ')}`;
    status.errors.push(aggregateReason);
    return finalizeFailedRun(aggregateReason, [...failedSteps][0]!);
  }
  try {
    assertWorkspaceRefsLive(prepared.workspaceDir, priorOutputRefs(status), 'final production output');
    for (const step of prepared.steps) {
      assertNativeRuntimeIdentityLive({
        identity: step.runtimeIdentity,
        projectRoot,
        runDir: prepared.runDir,
      });
    }
  } catch (error) {
    const message = `final production provenance failed: ${error instanceof Error ? error.message : String(error)}`;
    status.status = 'failed';
    status.completed_at = utcNowIso();
    status.errors.push(message);
    writeJsonAtomic(statusPath, status);
    throw new Error(message);
  }
  if (nativePauseRequested(stateManager, prepared.runId)) return finalizePausedRun();
  if (deadlineExpired()) { status.errors.push('native whole-run deadline expired before finalization'); return finalizeFailedRun(status.errors.at(-1)!, 'finalization'); }
  const producedOutputs = prepared.steps.flatMap(step => step.expectedOutputPaths.filter(filePath => fs.existsSync(filePath)));
  const completedStatus: ExecutionStatusFile = {...status,status:'completed',completed_at:utcNowIso()};
  const publication = writeComputationResultArtifact({prepared,status:completedStatus,statusPath,logsDir,producedOutputs,deferPublication:true});
  const assertPublicationLive = (): void => {
    if (nativePauseRequested(stateManager,prepared.runId)) throw new Error('native pause before local outcome publication');
    if (deadlineExpired()) throw new Error('native whole-run deadline expired during local outcome publication');
  };
  const completedState = stateManager.readState();
  try {
    assertPublicationLive();
    if (completedState.run_status !== 'running') throw new Error('native execution is not running at local outcome publication');
    stateManager.transitionStatus(completedState,'completed',{eventType:'execution_completed',details:{run_id:prepared.runId,execution_status:statusPath},commit_guard:assertPublicationLive,on_commit_failure:publication.rollback,before_commit:()=>{
      assertPublicationLive();
      publication.commit(assertPublicationLive);
      assertPublicationLive();
    }});
  } catch (error) {
    publication.rollback();
    if (error instanceof Error && error.message.includes('manual reconciliation required')) throw error;
    if (nativePauseRequested(stateManager,prepared.runId)) return finalizePausedRun();
    if (deadlineExpired()) {status.errors.push('native whole-run deadline expired during local outcome publication');return finalizeFailedRun(status.errors.at(-1)!,'finalization');}
    throw error;
  }
  publication.release();
  Object.assign(status,completedStatus);
  const {computationResult,computationResultPath,computationResultRef} = publication;
  maybeQueueIdeaEngineComputationFeedback({
    prepared,
    computationResult,
  });
  const memoryGraph = await recordComputationResultToMemoryGraph({
    projectRoot,
    manifest: prepared.manifest,
    computationResult,
  });
  if (memoryGraph.repairProposalPath) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      mutation_proposal_repair_v1: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
    };
    stateManager.saveStateWithLedger(state, 'repair_mutation_proposed', {
      details: {
        proposal_id: memoryGraph.repairProposalId,
        proposal_path: toPosixRelative(projectRoot, memoryGraph.repairProposalPath),
      },
    });
  } else if (memoryGraph.repairProposalSuppressed) {
    stateManager.appendLedger('proposal_suppressed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_kind: 'repair',
        proposal_fingerprint: memoryGraph.repairProposalFingerprint,
        suppression_decision: memoryGraph.repairSuppressionDecision,
      },
    });
  }
  const skillProposal = maybeGenerateSkillProposal({
    projectRoot,
    runId: prepared.runId,
    manifest: prepared.manifest,
    computationResult,
  });
  if (skillProposal && !skillProposal.suppressed) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      skill_proposal_v2: toPosixRelative(projectRoot, skillProposal.proposalPath),
    };
    stateManager.saveStateWithLedger(state, 'skill_proposal_generated', {
      details: {
        proposal_id: skillProposal.proposal.proposal_id,
        proposal_path: toPosixRelative(projectRoot, skillProposal.proposalPath),
      },
    });
  } else if (skillProposal?.suppressed) {
    stateManager.appendLedger('proposal_suppressed', {
      run_id: prepared.runId,
      workflow_id: 'computation',
      details: {
        proposal_kind: 'skill',
        proposal_fingerprint: skillProposal.proposalFingerprint,
        suppression_decision: skillProposal.decision,
      },
    });
  }
  const opportunityProposals = maybeGenerateOpportunityProposals({
    projectRoot,
    runId: prepared.runId,
    manifest: prepared.manifest,
    computationResult,
  });
  if (opportunityProposals.optimize || opportunityProposals.innovate) {
    const state = stateManager.readState();
    state.artifacts = {
      ...state.artifacts,
      ...(generatedProposal(opportunityProposals.optimize) ? { mutation_proposal_optimize_v1: toPosixRelative(projectRoot, opportunityProposals.optimize.proposalPath) } : {}),
      ...(generatedProposal(opportunityProposals.innovate) ? { mutation_proposal_innovate_v1: toPosixRelative(projectRoot, opportunityProposals.innovate.proposalPath) } : {}),
    };
    stateManager.saveStateWithLedger(state, 'opportunity_proposals_recorded');
    for (const [proposalKind, proposal] of [['optimize', opportunityProposals.optimize], ['innovate', opportunityProposals.innovate]] as const) {
      if (proposal && !('proposalPath' in proposal)) {
        stateManager.appendLedger('proposal_suppressed', {
          run_id: prepared.runId,
          workflow_id: 'computation',
          details: {
            proposal_kind: proposalKind,
            proposal_fingerprint: proposal.proposalFingerprint,
            suppression_decision: proposal.decision,
          },
        });
      }
    }
  }
  return {
    status: 'completed',
    ok: true,
    run_id: prepared.runId,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    artifact_paths: {
      execution_status: statusPath,
      logs_dir: logsDir,
      computation_result: computationResultPath,
    },
    outcome_ref: computationResultRef,
    next_actions: computationResult.next_actions,
    followup_bridge_refs: computationResult.followup_bridge_refs,
    summary: computationResult.summary,
    produced_outputs: producedOutputs,
  };
}
