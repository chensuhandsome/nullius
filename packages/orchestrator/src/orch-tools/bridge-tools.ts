import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, McpError, unsafeFs } from '@nullius/shared';
import {
  executeComputationManifest,
  planComputationFromRunDir,
  stageContentInRunDir,
  stageIdeaArtifactsIntoRunFromPath,
} from '../computation/index.js';
import {
  DEFAULT_FOLLOWUP_RUNTIME_MODEL,
  buildFollowupRuntimePrompt,
  followupRuntimeToolsForTaskKind,
} from '../computation/followup-runtime.js';
import { progressRunFollowups } from '../computation/progress-followups.js';
import { assertComputationResultValid } from '../computation/result-schema.js';
import { writeJsonAtomic } from '../computation/io.js';
import { executeTeamRuntimeFromToolParams } from '../team-execution-bridge.js';
import type { AgentToolHandlerContext } from './agent-runtime.js';
import type { DelegatedFollowupTeamConfig } from '../computation/feedback-followups.js';
import type {
  DelegatedComputationFollowupLaunchOutcome,
} from '../computation/delegated-followup-progression.js';
import type {
  DelegatedFeedbackFollowupTask,
} from '../computation/feedback-followup-selection.js';
import type { DelegatedComputationFollowupTask } from '../computation/delegated-followup-selection.js';
import type {
  FeedbackFollowupLaunchOutcome,
} from '../computation/feedback-followup-progression.js';
import { assertNoSymlinkComponents, resolveProjectContainedPath, resolveUnderRoot } from '../computation/path-safety.js';
import { utcNowIso } from '../util.js';
import { resolveProjectRoot } from './common.js';

function resolvePathWithinParent(parentDir: string, candidatePath: string, field: string): string {
  const resolvedParent = path.resolve(parentDir);
  const resolved = resolveUnderRoot(resolvedParent, candidatePath);
  if (resolved !== null) return resolved;
  throw invalidParams(`${field} must be within ${resolvedParent}`, {
    field,
    parent_dir: resolvedParent,
    candidate: candidatePath,
  });
}

/**
 * The project root and run directory a bridge tool works in. The root is
 * admitted like every other front door's (tilde expansion, canonical form,
 * outside any nullius checkout); the run directory must lie within it, by the
 * rule `nullius run --run-dir` applies: an alias above the root is accepted,
 * a symbolic link below it is refused, and so is one at an entry of the run
 * directory these tools use. Everything the tool writes, reads or executes
 * then derives from the admitted run directory.
 */
// The entries of a run directory these tools read and write. None may be a
// symbolic link, nor may any entry directly inside artifacts/ or attempts/: a
// link there would carry a staged artifact, a computation result or an attempt
// archive outside the run directory. (The computation workspace's own paths
// are checked when its manifest is materialized and prepared.)
const RUN_DIRECTORY_ENTRIES = ['artifacts', 'attempts', 'computation', 'run_origin.json'];
const RUN_DIRECTORY_LISTED = ['artifacts', 'attempts'];

function assertRunDirectoryEntriesAreReal(runDir: string): void {
  for (const entry of RUN_DIRECTORY_ENTRIES) {
    assertNoSymlinkComponents(runDir, path.join(runDir, entry), `run_dir/${entry}`, { allowMissingLeaf: true });
  }
  for (const dir of RUN_DIRECTORY_LISTED) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(runDir, dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      throw error;
    }
    for (const name of names) {
      const entry = path.join(runDir, dir, name);
      if (fs.lstatSync(entry).isSymbolicLink()) {
        throw unsafeFs(`run_dir/${dir}/${name} must not be a symbolic link`, { run_dir: runDir, symlink_path: entry });
      }
    }
  }
}

function admitProjectRun(params: { project_root: string; run_dir: string }): { projectRoot: string; runDir: string } {
  const projectRoot = resolveProjectRoot(params.project_root);
  if (!path.isAbsolute(params.run_dir)) {
    throw invalidParams('run_dir must be an absolute path inside project_root', {
      project_root: projectRoot,
      run_dir: params.run_dir,
    });
  }
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) {
    throw invalidParams('project_root must name an existing directory', { project_root: projectRoot });
  }
  const runDir = resolveProjectContainedPath(projectRoot, params.run_dir, 'run_dir');
  assertRunDirectoryEntriesAreReal(runDir);
  return { projectRoot, runDir };
}

export async function handleOrchRunStageIdea(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  handoff_path: string;
  handoff_uri?: string;
}) {
  const { runDir } = admitProjectRun(params);
  const staged = stageIdeaArtifactsIntoRunFromPath({
    handoffPath: params.handoff_path,
    handoffUri: params.handoff_uri,
    runDir,
  });
  return {
    status: 'staged',
    run_id: params.run_id,
    run_dir: params.run_dir,
    outline_seed_path: path.relative(runDir, staged.outlineSeedPath).split(path.sep).join('/'),
    hints_snapshot_path: path.relative(runDir, staged.hintsSnapshotPath).split(path.sep).join('/'),
    next_actions: [
      {
        tool: 'orch_run_plan_computation',
        reason: 'Compile the staged outline seed and hints into execution_plan_v1.json and computation/manifest.json before any execution.',
      },
    ],
  };
}

export async function handleOrchRunStageContent(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  content_type: 'section_output' | 'outline_plan' | 'paperset_curation' | 'revision_plan' | 'reviewer_report' | 'judge_decision';
  content: string;
  artifact_suffix?: string;
  task_id?: string;
  task_kind?: 'draft_update' | 'review';
}) {
  const { runDir } = admitProjectRun(params);
  return stageContentInRunDir({
    runId: params.run_id,
    runDir,
    contentType: params.content_type,
    content: params.content,
    artifactSuffix: params.artifact_suffix,
    taskId: params.task_id,
    taskKind: params.task_kind,
  });
}

export async function handleOrchRunPlanComputation(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  dry_run?: boolean;
}) {
  const { projectRoot, runDir } = admitProjectRun(params);
  return planComputationFromRunDir({
    dryRun: params.dry_run,
    projectRoot,
    runDir,
    runId: params.run_id,
  });
}

export async function handleOrchRunExecuteManifest(params: {
  project_root: string;
  run_id: string;
  run_dir: string;
  manifest_path: string;
  dry_run?: boolean;
}) {
  const { projectRoot, runDir } = admitProjectRun(params);
  const manifestPath = resolvePathWithinParent(runDir, params.manifest_path, 'manifest_path');
  resolvePathWithinParent(path.join(runDir, 'computation'), manifestPath, 'manifest_path');
  return executeComputationManifest({
    dryRun: params.dry_run,
    manifestPath,
    projectRoot,
    runDir,
    runId: params.run_id,
  });
}

function loadComputationResultFromRunDir(params: {
  runId: string;
  runDir: string;
}) {
  const computationResultPath = path.join(params.runDir, 'artifacts', 'computation_result_v1.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(computationResultPath, 'utf-8')) as unknown;
    const computationResult = assertComputationResultValid(parsed);
    if (computationResult.run_id !== params.runId) {
      throw invalidParams('computation_result_v1 run_id does not match run_id', {
        run_id: params.runId,
        computation_result_run_id: computationResult.run_id,
      });
    }
    return computationResult;
  } catch (error) {
    // A refusal keeps its own code; a read or parse failure (a missing or
    // unreadable file is a system error with a code too) is reported here.
    if (error instanceof McpError) {
      throw error;
    }
    throw invalidParams('Failed to load computation_result_v1 from run_dir', {
      run_id: params.runId,
      run_dir: params.runDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function findHandoffPayload(params: {
  computationResult: Awaited<ReturnType<typeof loadComputationResultFromRunDir>>;
  handoffId: string;
}): Record<string, unknown> | null {
  const handoff = params.computationResult.workspace_feedback.handoffs.find(item => item.handoff_id === params.handoffId);
  return handoff?.payload ?? null;
}

function findBridgeUri(params: {
  computationResult: Awaited<ReturnType<typeof loadComputationResultFromRunDir>>;
  handoffKind: DelegatedFollowupTeamConfig['handoff_kind'];
}): string | null {
  if (params.handoffKind === 'feedback') {
    return null;
  }
  const expectedArtifactName = params.handoffKind === 'writing'
    ? 'artifacts/writing_followup_bridge_v1.json'
    : 'artifacts/review_followup_bridge_v1.json';
  const match = params.computationResult.followup_bridge_refs.find(ref => ref.uri.includes(encodeURIComponent(expectedArtifactName)));
  return match?.uri ?? null;
}

async function launchFollowupTaskViaTeamRuntime(params: {
  ctx: AgentToolHandlerContext;
  computationResult: Awaited<ReturnType<typeof loadComputationResultFromRunDir>>;
  projectRoot: string;
  runId: string;
  runDir: string;
  task: DelegatedFeedbackFollowupTask | DelegatedComputationFollowupTask;
  team: DelegatedFollowupTeamConfig;
}): Promise<FeedbackFollowupLaunchOutcome | DelegatedComputationFollowupLaunchOutcome> {
  const { research_task_ref: _researchTaskRef, ...launchTeam } = params.team;
  const result = await executeTeamRuntimeFromToolParams({
    project_root: params.projectRoot,
    run_id: params.runId,
    model: DEFAULT_FOLLOWUP_RUNTIME_MODEL,
    messages: [{
      role: 'user',
      content: buildFollowupRuntimePrompt({
        projectRoot: params.projectRoot,
        runId: params.runId,
        runDir: params.runDir,
        taskId: params.task.task_id,
        taskKind: params.task.kind,
        taskTitle: params.task.title,
        computationResultUri: `rep://runs/${encodeURIComponent(params.runId)}/artifact/${encodeURIComponent('artifacts/computation_result_v1.json')}`,
        handoffId: params.team.handoff_id,
        handoffKind: params.team.handoff_kind,
        bridgeUri: findBridgeUri({
          computationResult: params.computationResult,
          handoffKind: params.team.handoff_kind,
        }),
        handoffPayload: findHandoffPayload({
          computationResult: params.computationResult,
          handoffId: params.team.handoff_id,
        }),
        taskMetadata: params.task.metadata && typeof params.task.metadata === 'object'
          ? params.task.metadata as Record<string, unknown>
          : null,
      }),
    }],
    tools: followupRuntimeToolsForTaskKind(params.task.kind),
    team: {
      ...launchTeam,
      coordination_policy: 'sequential',
    },
  }, params.ctx);
  const primary = result.assignment_results[0];
  if (
    primary
    && ['failed', 'needs_recovery', 'timed_out', 'cancelled', 'cascade_stopped'].includes(primary.status)
  ) {
    if (params.task.kind === 'idea' || params.task.kind === 'literature') {
      return {
        launchResult: {
          status: 'launch_failed',
          task_id: params.task.task_id,
          task_kind: params.task.kind,
          assignment_id: result.assignment_id,
          team_state_path: result.team_state_path,
          error: `delegated runtime finished with ${primary.status}`,
        },
        teamState: result.team_state,
      };
    }
    return {
      launchResult: {
        status: 'launch_failed',
        task_id: params.task.task_id,
        task_kind: params.task.kind,
        assignment_id: result.assignment_id,
        team_state_path: result.team_state_path,
        error: `delegated runtime finished with ${primary.status}`,
      },
      teamState: result.team_state,
    };
  }
  if (params.task.kind === 'idea' || params.task.kind === 'literature') {
    return {
      launchResult: {
        status: 'launched',
        task_id: params.task.task_id,
        task_kind: params.task.kind,
        assignment_id: result.assignment_id,
        team_state_path: result.team_state_path,
      },
      teamState: result.team_state,
    };
  }
  return {
    launchResult: {
      status: 'launched',
      task_id: params.task.task_id,
      task_kind: params.task.kind,
      assignment_id: result.assignment_id,
      team_state_path: result.team_state_path,
    },
    teamState: result.team_state,
  };
}

function syncCompletedFollowupTaskIntoComputationResult(params: {
  runId: string;
  runDir: string;
  launchResult: Awaited<ReturnType<typeof progressRunFollowups>>;
}): void {
  if (params.launchResult.status !== 'launched' || !params.launchResult.task_id || !params.launchResult.team_state_path) {
    return;
  }
  if (!fs.existsSync(params.launchResult.team_state_path)) {
    return;
  }
  const teamState = JSON.parse(fs.readFileSync(params.launchResult.team_state_path, 'utf-8')) as {
    delegate_assignments?: Array<{ task_id?: string; status?: string }>;
  };
  const assignment = teamState.delegate_assignments?.find(item => item.task_id === params.launchResult.task_id);
  if (assignment?.status !== 'completed') {
    return;
  }
  const computationResultPath = path.join(params.runDir, 'artifacts', 'computation_result_v1.json');
  const computationResult = loadComputationResultFromRunDir({
    runId: params.runId,
    runDir: params.runDir,
  });
  const task = computationResult.workspace_feedback.tasks.find(item => item.task_id === params.launchResult.task_id);
  if (!task || task.status === 'completed') {
    return;
  }
  task.status = 'completed';
  task.updated_at = utcNowIso();
  computationResult.workspace_feedback.active_task_ids = computationResult.workspace_feedback.active_task_ids
    .filter(taskId => taskId !== params.launchResult.task_id);
  writeJsonAtomic(computationResultPath, assertComputationResultValid(computationResult));
}

export async function handleOrchRunProgressFollowups(
  params: {
    _confirm: true;
    project_root: string;
    run_id: string;
    run_dir: string;
  },
  ctx: AgentToolHandlerContext = {},
) {
  const { projectRoot, runDir } = admitProjectRun(params);
  if (!ctx.createMessage || !ctx.callTool) {
    throw invalidParams('orch_run_progress_followups requires host sampling/createMessage support and tool-call loopback.', {
      missing_context: [
        ...(!ctx.createMessage ? ['createMessage'] : []),
        ...(!ctx.callTool ? ['callTool'] : []),
      ],
    });
  }
  const computationResult = loadComputationResultFromRunDir({
    runId: params.run_id,
    runDir,
  });
  const result = await progressRunFollowups({
    computationResult,
    projectRoot,
    runId: params.run_id,
    runDir,
    launchFeedbackTask: async launchParams => launchFollowupTaskViaTeamRuntime({
      ctx,
      computationResult: launchParams.computationResult,
      projectRoot: launchParams.projectRoot,
      runId: launchParams.runId,
      runDir,
      task: launchParams.task,
      team: launchParams.team,
    }) as Promise<FeedbackFollowupLaunchOutcome>,
    launchWritingReviewTask: async launchParams => launchFollowupTaskViaTeamRuntime({
      ctx,
      computationResult: launchParams.computationResult,
      projectRoot: launchParams.projectRoot,
      runId: launchParams.runId,
      runDir,
      task: launchParams.task,
      team: launchParams.team,
    }) as Promise<DelegatedComputationFollowupLaunchOutcome>,
  });
  syncCompletedFollowupTaskIntoComputationResult({
    runId: params.run_id,
    runDir,
    launchResult: result,
  });
  return result;
}
