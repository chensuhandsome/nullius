import { assertExecutionRunDirectory } from '../run-paths.js';
import * as path from 'node:path';
import { invalidParams } from '@nullius/shared';
import { prepareManifest } from './manifest.js';
import { ensureA3Approval } from './approval.js';
import { stampComputationLaunch } from './launch-stamp.js';
import { assertNativeEntry, nativeDeadlineExpired, readExpiredNativeFailure } from './native-control.js';
import { isInsideStampableRoot } from '../run-stamp.js';
import { runPreparedManifest } from './runner.js';
import type {
  DryRunExecutionResult,
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';
import { bridgeStagedIdeaToComputation } from './bridge.js';
import { loadStagedIdeaSurfaceFromRunDir } from './staged-idea-artifacts.js';

function dryRunResult(input: ExecuteComputationManifestInput): DryRunExecutionResult {
  const prepared = prepareManifest(input);
  return {
    status: 'dry_run',
    validated: true,
    dry_run: true,
    manifest_path: prepared.manifestRelativePath,
    manifest_sha256: prepared.manifestSha256,
    workspace_dir: prepared.workspaceDir,
    step_order: [...prepared.stepOrder],
    steps: prepared.stepOrder.map(stepId => {
      const step = prepared.steps.find(candidate => candidate.id === stepId)!;
      return {
        id: step.id,
        tool: step.tool,
        script: step.scriptRelativePath,
        command: [...step.argv],
        expected_outputs: [...step.expectedOutputs],
      };
    }),
  };
}

export async function executeComputationManifest(
  input: ExecuteComputationManifestInput,
): Promise<ExecuteComputationManifestResult> {
  // Inside a stampable run root, a run's directory basename IS its identity:
  // the traceability read model scans directories by name and the launch
  // stamp derives its ledger run id from the basename, while the execution
  // result carries the supplied runId. Letting them differ there splits one
  // run into two identities (a stamp for one name, results under another),
  // so the mismatch is refused before anything happens — dry-run included,
  // validation being exactly what dry-run is for. OUTSIDE the run roots
  // (a run directory elsewhere inside the project root, which
  // `nullius run --run-dir` accepts; the MCP bridge tools accept only the
  // run's own directory) no launch stamp is taken and that directory is not
  // scanned by name, so the names may differ. Approval packets, proposals
  // and team state for the run id still live under
  // <project>/artifacts/runs/<run_id>/, so a run directory elsewhere splits a
  // run's records between the two places.
  // Root membership uses the SAME symlink-resolved predicate as the stamp
  // containment — two resolution semantics would let an aliased project
  // root stamp a directory this check called outside.
  const runDirBasename = path.basename(path.resolve(input.runDir));
  if (isInsideStampableRoot(input.projectRoot, input.runDir) && runDirBasename !== input.runId) {
    throw invalidParams(
      'run_id must equal the run directory basename inside a run root (one run, one identity)',
      {
        run_id: input.runId,
        run_dir_basename: runDirBasename,
      },
    );
  }
  assertExecutionRunDirectory(input.runDir, input.projectRoot, input.runId);
  if (input.dryRun) {
    return dryRunResult(input);
  }
  assertNativeEntry(input.projectRoot, input.runId, path.dirname(input.manifestPath));
  const previousFailure = readExpiredNativeFailure(input.projectRoot, input.runId, input.runDir, path.dirname(input.manifestPath));
  if (previousFailure) return previousFailure;
  const expired = nativeDeadlineExpired(path.dirname(input.manifestPath));
  const prepared = prepareManifest(input);
  const approval = expired ? null : ensureA3Approval(input.projectRoot, prepared);
  if (approval) {
    return approval;
  }
  let originStamp: ReturnType<typeof stampComputationLaunch> | undefined;
  const result = await runPreparedManifest(input.projectRoot, prepared, () => {
    originStamp = stampComputationLaunch(input.projectRoot, input.runDir);
    if (originStamp.status === 'refused_relaunch') throw invalidParams(originStamp.detail, { validation_layer: 'attempt_boundary', run_id: input.runId });
  });
  return originStamp ? { ...result, origin_stamp: originStamp } : result;
}

export async function planComputationFromRunDir(input: {
  projectRoot: string;
  runId: string;
  runDir: string;
  dryRun?: boolean;
}) {
  assertExecutionRunDirectory(input.runDir, input.projectRoot, input.runId);
  const stagedIdea = loadStagedIdeaSurfaceFromRunDir(input.runDir);
  return bridgeStagedIdeaToComputation({
    dryRun: input.dryRun,
    projectRoot: input.projectRoot,
    runDir: input.runDir,
    runId: input.runId,
    stagedIdea,
  });
}

export { bridgeStagedIdeaToComputation, type ComputeBridgeInput, type ComputeBridgeResult } from './bridge.js';
export {
  extractIdeaStagingHints,
  parseIdeaHandoffRecord,
  readIdeaHandoffRecord,
  stageIdeaArtifactsIntoRun,
  stageIdeaArtifactsIntoRunFromPath,
  type StagedIdeaHintsSnapshotV1,
} from './staged-idea-artifacts.js';
export { loadStagedIdeaSurfaceFromRunDir } from './staged-idea-artifacts.js';
export {
  createStagedContentArtifactRef,
  readStagedContentArtifactFromRunDir,
  stageContentInRunDir,
} from './staged-content.js';
export {
  buildTeamConfigForDelegatedFollowupTask,
  primeDelegatedFollowupTeamState,
  attachDelegatedFollowupTeamExecutionMetadata,
  type DelegatedFollowupTeamConfig,
} from './feedback-followups.js';
export {
  hasCompletedDelegatedFeedbackAssignmentForTask,
  selectDelegatedFeedbackFollowupTask,
  type DelegatedFeedbackFollowupTask,
} from './feedback-followup-selection.js';
export {
  progressDelegatedFeedbackFollowups,
  type FeedbackFollowupLaunchResult,
  type FeedbackFollowupLaunchStatus,
} from './feedback-followup-progression.js';
export {
  progressRunFollowups,
  type ProgressFollowupsBranch,
  type ProgressFollowupsResult,
  type ProgressFollowupsStatus,
} from './progress-followups.js';
export {
  hasCompletedDelegatedFollowupAssignmentForTask,
  selectDelegatedComputationFollowupTask,
  type DelegatedComputationFollowupTask,
} from './delegated-followup-selection.js';
export {
  progressDelegatedComputationFollowups,
  type DelegatedComputationFollowupLaunchResult,
} from './delegated-followup-progression.js';
export type {
  DelegatedComputationFollowupLaunchStatus,
} from './delegated-followup-progression.js';
export {
  evaluateReviewFollowupGate,
  type ReviewFollowupGateDecision,
  type ReviewFollowupGateResult,
} from './review-followup-gate.js';
export {
  buildFollowupRuntimePrompt,
  DEFAULT_FOLLOWUP_RUNTIME_MODEL,
  FEEDBACK_FOLLOWUP_RUNTIME_TOOLS,
  WRITING_REVIEW_FOLLOWUP_RUNTIME_TOOLS,
  followupRuntimeToolsForTaskKind,
} from './followup-runtime.js';
export type {
  ExecuteComputationManifestInput,
  ExecuteComputationManifestResult,
} from './types.js';
