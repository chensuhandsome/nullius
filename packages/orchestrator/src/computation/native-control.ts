import * as fs from 'node:fs';
import * as path from 'node:path';
import { StateManager } from '../state-manager.js';
import { assertComputationResultValid } from './result-schema.js';
import { createRunArtifactRef } from './artifact-refs.js';
import type { FailedExecutionResult } from './types.js';

/** Refuse paused native re-entry before preparation, approval, preflight or stamping writes. */
export function assertNativeEntry(projectRoot: string, runId: string, workspaceDir: string): void {
  const manager = new StateManager(projectRoot);
  const state = manager.readState();
  if (state.run_id !== null && state.run_id !== runId) throw new Error('orchestrator run_id does not match native execution run_id');
  const statusPath = path.join(workspaceDir, 'execution_status.json');
  const status = fs.existsSync(statusPath) ? JSON.parse(fs.readFileSync(statusPath, 'utf-8')) : null;
  if (state.run_status === 'paused' || manager.checkStopPause() || status?.status === 'paused') {
    throw new Error('paused native computation: continuation in place is unsupported; use a separately approved fresh run');
  }
}

export function nativePauseRequested(manager: StateManager, runId: string): boolean {
  const state = manager.readState();
  if (state.run_id !== runId) throw new Error('native execution run identity changed; refusing further dispatch or finalization');
  return state.run_status === 'paused' || manager.checkStopPause() !== null;
}

export function nativeDeadlineExpired(workspaceDir: string): boolean {
  const statusPath = path.join(workspaceDir, 'execution_status.json');
  if (!fs.existsSync(statusPath)) return false;
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
  if (status.deadline_at == null) return false;
  const deadline = Date.parse(status.deadline_at);
  if (!Number.isFinite(deadline)) throw new Error('invalid persisted native deadline');
  return deadline <= Date.now();
}

/** Re-entry into an exhausted failed run returns its recorded outcome without rebinding inputs. */
export function readExpiredNativeFailure(projectRoot: string, runId: string, runDir: string, workspaceDir: string): FailedExecutionResult | null {
  if (!nativeDeadlineExpired(workspaceDir)) return null;
  const statusPath = path.join(workspaceDir, 'execution_status.json');
  const status = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
  if (status.run_id !== runId) throw new Error('execution status run identity mismatch');
  if (status.status === 'completed') throw new Error('native whole-run deadline expired; completed evidence cannot be relaunched in place');
  const resultPath = path.join(runDir, 'artifacts/computation_result_v1.json');
  if (status.status !== 'failed' || !fs.existsSync(resultPath)) return null;
  const result = assertComputationResultValid(JSON.parse(fs.readFileSync(resultPath, 'utf-8')));
  if (result.run_id !== runId || result.execution_status !== 'failed') throw new Error('expired native outcome identity/status mismatch');
  const manager = new StateManager(projectRoot);
  const state = manager.readState();
  if (state.run_status === 'running') manager.transitionStatus(state,'failed',{eventType:'execution_failed',details:{run_id:runId,reason:'native whole-run deadline expired before re-entry'}});
  return {status:'failed',ok:false,run_id:runId,manifest_path:status.manifest_path,manifest_sha256:status.manifest_sha256,
    artifact_paths:{execution_status:statusPath,logs_dir:path.join(workspaceDir,'logs'),computation_result:resultPath},
    outcome_ref:createRunArtifactRef(runId,runDir,resultPath,'computation_result'),next_actions:result.next_actions,
    followup_bridge_refs:result.followup_bridge_refs,summary:result.summary,
    errors:[...status.errors, ...(status.errors.some((value:string)=>value.includes('deadline'))?[]:['native whole-run deadline expired before re-entry'])]};
}
