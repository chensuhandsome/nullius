import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sortKeysRecursive } from '@nullius/shared';
import { StateManager } from '../state-manager.js';
import { assertNoSymlinkComponents, assertCommandAllowed, resolveUnderRoot, resolveWithinRoot } from './path-safety.js';
import type { PreparedManifest } from './types.js';
import { sha256File } from './io.js';
import { nativeExecutableCandidates } from '../python-runtime.js';

export function preparedPreflight(prepared: PreparedManifest) {
  const template = prepared.manifest.preflight;
  if (!template?.length) return null;
  const step = prepared.steps.find(s => s.scriptPath === prepared.entryPointScriptPath) ?? prepared.steps[0]!;
  const argv = template.map(part => part.split('{entry}').join(prepared.entryPointScriptPath));
  assertCommandAllowed(argv);
  const candidates = argv[0] === step.runtimeIdentity.requested_token ? [step.runtimeIdentity.canonical_path]
    : path.isAbsolute(argv[0]!) ? [argv[0]!]
    : nativeExecutableCandidates(argv[0]!, step.executionEnvironment.variables.PATH!.split(path.delimiter));
  const executable = candidates.find(file => {
    try { fs.accessSync(file, fs.constants.X_OK); return fs.statSync(file).isFile(); } catch { return false; }
  });
  if (!executable) throw new Error('manifest preflight executable is unavailable');
  argv[0] = fs.realpathSync.native(executable);
  return { argv, environment: step.executionEnvironment, stepLimitMinutes: step.timeoutMinutes, runtime_sha256: sha256File(argv[0]!) };
}

/** Bind the inputs already declared by this execution; no complete runtime closure is claimed. */
export function executionBinding(projectRoot: string, prepared: PreparedManifest): { sha256: string; content: Record<string, unknown> } {
  const dependencies = prepared.manifest.dependencies as { lock_files?: string[]; data_files?: string[]; external_dependency_refs?: Array<{ path: string }> };
  const names = new Set([...(dependencies.lock_files ?? []), ...(dependencies.data_files ?? [])]);
  for (const step of prepared.steps) for (const arg of step.argv.slice(2)) {
    // An absolute argument may name a workspace file through an alias above
    // the workspace; the step-argument gate admits it as workspace-contained,
    // so it must be bound here too.
    const file = resolveUnderRoot(prepared.workspaceDir, arg);
    if (file !== null && fs.existsSync(file) && fs.statSync(file).isFile() && !prepared.steps.some(s => s.expectedOutputPaths.includes(file))) {
      names.add(path.relative(prepared.workspaceDir, file));
    }
  }
  const fileIdentity = (file: string) => ({ path: fs.realpathSync.native(file), sha256: sha256File(file), size_bytes: fs.statSync(file).size });
  const inputs = [...names].sort().map(name => {
    const file = resolveWithinRoot(prepared.workspaceDir, name, 'approved input');
    assertNoSymlinkComponents(prepared.workspaceDir, file, 'approved input');
    return fileIdentity(file);
  });
  const content = {
    project_root: fs.realpathSync.native(projectRoot), run_id: prepared.runId, run_dir: fs.realpathSync.native(prepared.runDir),
    manifest: fileIdentity(prepared.manifestPath),
    steps: prepared.steps.map(step => ({ id: step.id, argv: step.argv, script: fileIdentity(step.scriptPath), runtime: fileIdentity(step.runtimeIdentity.canonical_path), environment: step.executionEnvironment, gates: step.gates })),
    step_order: prepared.stepOrder, preflight: preparedPreflight(prepared), inputs,
    external_dependencies: (dependencies.external_dependency_refs ?? []).map(ref => fileIdentity(ref.path)).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    approval_policy: new StateManager(projectRoot).readPolicy(),
  };
  return { content, sha256: createHash('sha256').update(JSON.stringify(sortKeysRecursive(content))).digest('hex') };
}
