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
import { resolveProjectContainedPath, resolveUnderRoot } from '../computation/path-safety.js';
import { utcNowIso } from '../util.js';
import { resolveProjectRoot } from './common.js';
import { runDirFor, HISTORICAL_RUN_UNAVAILABLE_PREFIX } from '../run-paths.js';

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

// What the run directory must look like before a bridge tool works in it.
// No symbolic link may stand anywhere in it, so nothing these tools or the
// computation code behind them read or write there (staged artifacts,
// approval packets, attempt archives, team state, launch stamps, execution
// logs and status) can lie outside it. The one exception is the method's own
// workspace below computation/ (its scripts, data and outputs, which may be
// large): the paths a manifest names there are checked when it is
// materialized and prepared. Entries the tools create must also be of the
// kind they create (directories, and a file for run_origin.json), so a
// misplaced file is refused here rather than failing a later write.
const RUN_DIRECTORY_DIRECTORIES = ['artifacts', 'attempts', 'approvals', 'computation'];
const RUN_DIRECTORY_FILES = ['run_origin.json'];
// Below computation/, the entries the computation code manages itself (the
// runtime creates them in computation/runner.ts; a new managed subtree must be
// added here, or links inside it would be admitted as method workspace files).
const COMPUTATION_MANAGED_DIRECTORIES = ['logs'];

function lstatIfPresent(entry: string, runDir: string): fs.Stats | null {
  try {
    return fs.lstatSync(entry);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw unsafeFs(`cannot inspect ${entry}: ${error instanceof Error ? error.message : String(error)}`, {
      run_dir: runDir,
      path: entry,
      ...(typeof code === 'string' ? { errno: code } : {}),
    });
  }
}

function listDirectory(dir: string, runDir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw unsafeFs(`cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`, {
      run_dir: runDir,
      path: dir,
      ...(typeof code === 'string' ? { errno: code } : {}),
    });
  }
}

function refuseSpecialFile(entry: string, runDir: string): never {
  throw unsafeFs(`run_dir/${path.relative(runDir, entry)} must be a regular file or a directory`, { run_dir: runDir, path: entry });
}

function refuseLink(entry: string, runDir: string): never {
  throw unsafeFs(`run_dir/${path.relative(runDir, entry).split(path.sep).join('/')} must not be a symbolic link`, {
    run_dir: runDir,
    symlink_path: entry,
  });
}

/** Refuse any symbolic link at or below `dir`. */
function assertNoLinksBelow(dir: string, runDir: string): void {
  for (const name of listDirectory(dir, runDir)) {
    const entry = path.join(dir, name);
    const stat = lstatIfPresent(entry, runDir);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) refuseLink(entry, runDir);
    if (stat.isDirectory()) assertNoLinksBelow(entry, runDir);
    else if (!stat.isFile()) refuseSpecialFile(entry, runDir);
  }
}

function assertRunDirectoryIsReal(runDir: string): void {
  const run = lstatIfPresent(runDir, runDir);
  if (run === null) return;
  if (!run.isDirectory()) {
    throw unsafeFs('run_dir must name a directory', { run_dir: runDir });
  }
  for (const name of RUN_DIRECTORY_DIRECTORIES.concat(RUN_DIRECTORY_FILES)) {
    const stat = lstatIfPresent(path.join(runDir, name), runDir);
    if (stat === null || stat.isSymbolicLink()) continue;
    const wantsDirectory = RUN_DIRECTORY_DIRECTORIES.includes(name);
    // A regular file is required where a file is expected: a FIFO or device node
    // there would stall or misread the tools that open it.
    if (wantsDirectory ? !stat.isDirectory() : !stat.isFile()) {
      throw unsafeFs(`run_dir/${name} must be a ${wantsDirectory ? 'directory' : 'regular file'}`, { run_dir: runDir, path: path.join(runDir, name) });
    }
  }
  for (const name of listDirectory(runDir, runDir)) {
    const entry = path.join(runDir, name);
    const stat = lstatIfPresent(entry, runDir);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) refuseLink(entry, runDir);
    if (!stat.isDirectory()) {
      if (!stat.isFile()) refuseSpecialFile(entry, runDir);
      continue;
    }
    if (name !== 'computation') {
      assertNoLinksBelow(entry, runDir);
      continue;
    }
    // The computation directory: every direct entry, and everything below the
    // subtrees the computation code manages; entries nested below the method's
    // own real workspace directories are the manifest checks' business.
    for (const inner of listDirectory(entry, runDir)) {
      const innerEntry = path.join(entry, inner);
      const innerStat = lstatIfPresent(innerEntry, runDir);
      if (innerStat === null) continue;
      if (innerStat.isSymbolicLink()) refuseLink(innerEntry, runDir);
      if (!innerStat.isDirectory() && !innerStat.isFile()) refuseSpecialFile(innerEntry, runDir);
      if (innerStat.isDirectory() && COMPUTATION_MANAGED_DIRECTORIES.includes(inner)) assertNoLinksBelow(innerEntry, runDir);
    }
  }
}

/**
 * The project root and run directory a bridge tool works in. The root is
 * admitted like every other front door's (tilde expansion, canonical form,
 * outside any nullius checkout). The run directory must be the run's own,
 * <project_root>/artifacts/runs/<run_id>, where its approval packets,
 * proposals and team state are kept by run id, so a run's records are never
 * split between two directories; it may be spelled through an alias above
 * the root, while a symbolic link below the root is refused, and so is one
 * anywhere in the run directory, including every entry directly under
 * computation/; only entries nested below the method's own real workspace
 * directories are left to the manifest checks
 * (the walk is assertRunDirectoryIsReal, a pathname check at call time; the
 * manifest checks at materialization and preparation re-verify declared paths). Everything the tool writes, reads or executes
 * then derives from the admitted run directory.
 */
function admitProjectRun(params: { project_root: string; run_id: string; run_dir: string }): { projectRoot: string; runDir: string } {
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
  let ownRunDir: string;
  try {
    ownRunDir = runDirFor(projectRoot, params.run_id);
  } catch (error) {
    // An invalid run id, or one a historical run owns: the caller's to change;
    // a historical run that cannot be inspected is the environment's.
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith(HISTORICAL_RUN_UNAVAILABLE_PREFIX)) throw unsafeFs(message, { project_root: projectRoot, run_id: params.run_id });
    throw invalidParams(message, { project_root: projectRoot, run_id: params.run_id });
  }
  if (runDir !== ownRunDir) {
    throw invalidParams('run_dir must be the run\'s own directory, <project_root>/artifacts/runs/<run_id>', {
      project_root: projectRoot,
      run_id: params.run_id,
      run_dir: params.run_dir,
      expected_run_dir: ownRunDir,
    });
  }
  assertRunDirectoryIsReal(runDir);
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
  // A relative path would be read against the server's working directory.
  if (!path.isAbsolute(params.handoff_path)) {
    throw invalidParams('handoff_path must be an absolute path', { handoff_path: params.handoff_path });
  }
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
