import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidParams, sortKeysRecursive, type ComputationManifestV1, type ExecutionPlanV1 } from '@nullius/shared';
import { utcNowIso } from '../util.js';
import { assertNoSymlinkComponents, sanitizeRelativePath } from './path-safety.js';
import { ensureDir, toPosixRelative, writeJsonAtomic, writeTextAtomic } from './io.js';
import { assertComputationManifestValid } from './manifest.js';

export interface MaterializedExecutionPlan {
  manifestPath: string;
  manifest: ComputationManifestV1;
}

function materializationError(message: string, details: Record<string, unknown> = {}): never {
  throw invalidParams(message, { validation_layer: 'materialization', ...details });
}

interface MaterializationOptions {
  methodSpec?: Record<string, unknown> | null;
}

interface ProviderMethodSpecFile {
  path: string;
  content: string;
  executable: boolean;
}

interface ProviderBackedPhase {
  phaseId: string;
  description?: string;
  cwd: string;
  tool: 'python' | 'julia' | 'bash' | 'mathematica';
  script: string;
  args: string[];
  outputs: string[];
  dependsOn: string[];
  timeoutMinutes: number | null;
}

interface ProviderBackedMethodBundle {
  files: ProviderMethodSpecFile[];
  phases: ProviderBackedPhase[];
  title: string;
  description?: string;
}

function readStringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    materializationError(`${label} must be a non-empty string`, { field });
  }
  return value.trim();
}

function readRawStringField(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    materializationError(`${label} must be a non-empty string`, { field });
  }
  return value;
}

function toRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    materializationError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function sanitizeWorkspacePath(relativePath: string, label: string): string {
  return sanitizeRelativePath(relativePath.replace(/\\/g, '/'), label);
}

/**
 * Write the method's files under `computationDir`. Every target is checked
 * before the first write, as the manifest's own paths are checked when it is
 * prepared: it stays within the run directory, and no existing component from
 * the run directory down is a symbolic link, so a link left in the run
 * directory cannot carry a file elsewhere.
 */
function writeProviderFiles(runDir: string, computationDir: string, files: ProviderMethodSpecFile[]): void {
  const targets = files.map((file, index) => {
    const filePath = path.join(computationDir, file.path);
    assertNoSymlinkComponents(runDir, filePath, `method_spec.files[${index}].path`, { allowMissingLeaf: true });
    return { file, filePath };
  });
  for (const { file, filePath } of targets) {
    ensureDir(path.dirname(filePath));
    writeTextAtomic(filePath, file.content);
    if (file.executable) {
      fs.chmodSync(filePath, 0o755);
    }
  }
}

function detectPhaseTool(argv0: string): ProviderBackedPhase['tool'] {
  const normalized = path.basename(argv0).toLowerCase();
  if (normalized === 'python' || normalized.startsWith('python3')) return 'python';
  if (normalized === 'julia') return 'julia';
  if (normalized === 'bash' || normalized === 'sh') return 'bash';
  if (normalized === 'wolframscript') return 'mathematica';
  materializationError('method_spec.run_card backend argv[0] is unsupported for provider-backed materialization', {
    argv0,
  });
}

function prefixWithCwd(cwd: string, relativePath: string, label: string): string {
  const safePath = sanitizeWorkspacePath(relativePath, label);
  if (cwd === '.' || cwd === '') {
    return safePath;
  }
  return sanitizeWorkspacePath(path.posix.join(cwd, safePath), label);
}

function parseProviderBackedMethodBundle(methodSpec: Record<string, unknown>): ProviderBackedMethodBundle {
  const filesInput = methodSpec.files;
  const runCardInput = methodSpec.run_card;
  if (!Array.isArray(filesInput)) {
    materializationError('method_spec.files must be present for provider-backed materialization');
  }
  const runCard = toRecord(runCardInput, 'method_spec.run_card');
  if (runCard.schema_version !== 2) {
    materializationError('method_spec.run_card.schema_version must be 2 for provider-backed materialization');
  }
  if (runCard.workflow_id !== 'computation') {
    materializationError('method_spec.run_card.workflow_id must be computation for provider-backed materialization');
  }
  const title = readStringField(runCard, 'title', 'method_spec.run_card.title');
  const descriptionValue = runCard.description;
  const description = typeof descriptionValue === 'string' && descriptionValue.trim().length > 0
    ? descriptionValue.trim()
    : undefined;
  const files = filesInput.map((entry, index) => {
    const record = toRecord(entry, `method_spec.files[${index}]`);
    const filePath = sanitizeWorkspacePath(
      readStringField(record, 'path', `method_spec.files[${index}].path`),
      `method_spec.files[${index}].path`,
    );
    const content = readRawStringField(record, 'content', `method_spec.files[${index}].content`);
    const executable = record.executable === true;
    return { path: filePath, content, executable };
  });
  const phasesInput = runCard.phases;
  if (!Array.isArray(phasesInput) || phasesInput.length === 0) {
    materializationError('method_spec.run_card.phases must contain at least one phase');
  }
  const phases = phasesInput.map((entry, index) => {
    const record = toRecord(entry, `method_spec.run_card.phases[${index}]`);
    const backend = toRecord(record.backend, `method_spec.run_card.phases[${index}].backend`);
    if (backend.kind !== 'shell') {
      materializationError('method_spec.run_card phases must use shell backends for provider-backed materialization', {
        phase_index: index,
        backend_kind: backend.kind,
      });
    }
    const argv = backend.argv;
    if (!Array.isArray(argv) || argv.some(item => typeof item !== 'string' || item.trim().length === 0)) {
      materializationError('method_spec.run_card backend argv must be a non-empty string array', {
        phase_index: index,
      });
    }
    if (argv.length < 2) {
      materializationError('method_spec.run_card backend argv must include interpreter and script path', {
        phase_index: index,
      });
    }
    const cwdValue = backend.cwd;
    const cwd = cwdValue === undefined ? '.' : readStringField(backend, 'cwd', `method_spec.run_card.phases[${index}].backend.cwd`);
    const safeCwd = sanitizeWorkspacePath(cwd, `method_spec.run_card.phases[${index}].backend.cwd`);
    const tool = detectPhaseTool(argv[0]!);
    const script = prefixWithCwd(
      safeCwd,
      readStringField({ script: argv[1] }, 'script', `method_spec.run_card.phases[${index}].backend.argv[1]`),
      `method_spec.run_card.phases[${index}].backend.argv[1]`,
    );
    const outputsInput = record.outputs;
    if (!Array.isArray(outputsInput) || outputsInput.length === 0) {
      materializationError('method_spec.run_card phase outputs must be a non-empty string array', {
        phase_index: index,
      });
    }
    const outputs = outputsInput.map((output, outputIndex) => {
      if (typeof output !== 'string' || output.trim().length === 0) {
        materializationError('method_spec.run_card phase outputs must be non-empty strings', {
          phase_index: index,
          output_index: outputIndex,
        });
      }
      return prefixWithCwd(safeCwd, output, `method_spec.run_card.phases[${index}].outputs[${outputIndex}]`);
    });
    const dependsOnInput = record.depends_on;
    const dependsOn = Array.isArray(dependsOnInput)
      ? dependsOnInput.map((dep, depIndex) => {
        if (typeof dep !== 'string' || dep.trim().length === 0) {
          materializationError('method_spec.run_card depends_on must contain non-empty strings', {
            phase_index: index,
            depends_on_index: depIndex,
          });
        }
        return dep.trim();
      })
      : [];
    const timeoutSeconds = backend.timeout_seconds;
    const timeoutMinutes = typeof timeoutSeconds === 'number'
      ? Math.max(1, Math.ceil(timeoutSeconds / 60))
      : null;
    const descriptionValue = record.description;
    return {
      phaseId: readStringField(record, 'phase_id', `method_spec.run_card.phases[${index}].phase_id`),
      description: typeof descriptionValue === 'string' && descriptionValue.trim().length > 0
        ? descriptionValue.trim()
        : undefined,
      cwd: safeCwd,
      tool,
      script,
      args: argv.slice(2),
      outputs,
      dependsOn,
      timeoutMinutes,
    };
  });
  return { files, phases, title, description };
}

/** True only for a timestamp in exactly the form `utcNowIso` writes, naming a real instant. */
function isUtcSecondTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.getTime()) && instant.toISOString().replace(/\.\d{3}Z$/, 'Z') === value;
}

/**
 * `fresh` carrying the creation time of the artifact already staged at
 * `filePath` when their content is otherwise identical. An A3 approval binds
 * the exact staged bytes, so planning again from unchanged inputs must
 * reproduce them; a new timestamp alone would void the approval. Any change
 * in content, or a staged timestamp not in the form planning writes, still
 * yields a newly stamped artifact.
 */
export function keepStagedCreatedAt<T extends { created_at?: string }>(filePath: string, fresh: T): T {
  let staged: unknown;
  try {
    staged = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return fresh;
  }
  if (!staged || typeof staged !== 'object' || Array.isArray(staged)) return fresh;
  const { created_at: stagedAt, ...stagedContent } = staged as Record<string, unknown>;
  const { created_at: _freshAt, ...content } = fresh;
  return isUtcSecondTimestamp(stagedAt)
    && JSON.stringify(sortKeysRecursive(stagedContent)) === JSON.stringify(sortKeysRecursive(content))
    ? { ...fresh, created_at: stagedAt }
    : fresh;
}

function materializeProviderBackedManifest(
  runDir: string,
  executionPlan: ExecutionPlanV1,
  bundle: ProviderBackedMethodBundle,
): MaterializedExecutionPlan {
  const computationDir = path.join(runDir, 'computation');
  const manifestPath = path.join(computationDir, 'manifest.json');
  // Checked before the first write, like the method's files: the manifest is
  // neither read nor written through a link in the run directory, also when
  // the method has no files.
  assertNoSymlinkComponents(runDir, manifestPath, 'computation/manifest.json', { allowMissingLeaf: true });
  writeProviderFiles(runDir, computationDir, bundle.files);
  const tools = new Set(bundle.phases.map(phase => phase.tool));
  const fresh = assertComputationManifestValid({
    schema_version: 1,
    title: executionPlan.objective,
    description: bundle.description
      ? `${bundle.description}\n\nProvider-backed execution materialized from staged method_spec.run_card.`
      : 'Provider-backed execution materialized from staged method_spec.run_card.',
    entry_point: {
      script: bundle.phases[0]!.script,
      tool: bundle.phases[0]!.tool,
      args: [...bundle.phases[0]!.args],
    },
    steps: bundle.phases.map(phase => ({
      id: phase.phaseId,
      description: phase.description ?? phase.phaseId,
      tool: phase.tool,
      script: phase.script,
      args: [...phase.args],
      expected_outputs: [...phase.outputs],
      ...(phase.dependsOn.length > 0 ? { depends_on: [...phase.dependsOn] } : {}),
      ...(phase.timeoutMinutes ? { timeout_minutes: phase.timeoutMinutes } : {}),
    })),
    environment: {
      ...(tools.has('python') ? { python_version: '3.11' } : {}),
      ...(tools.has('julia') ? { julia_version: '1.9' } : {}),
      platform: 'any',
      notes: 'Execution is provider-backed from the staged method bundle; orchestrator only materializes the approved run-local manifest.',
    },
    dependencies: {},
    computation_budget: {
      estimated_runtime_minutes: bundle.phases.length,
      max_runtime_minutes: Math.max(
        bundle.phases.length,
        bundle.phases.reduce((sum, phase) => sum + (phase.timeoutMinutes ?? 1), 0),
      ),
      notes: 'Budget applies to the provider-backed execution bundle materialized from the staged method bundle.',
    },
    outputs: [...new Set(bundle.phases.flatMap(phase => phase.outputs))],
    created_at: utcNowIso(),
  });
  const manifest = keepStagedCreatedAt(manifestPath, fresh);
  writeJsonAtomic(manifestPath, manifest);
  return { manifestPath, manifest };
}

export function materializeExecutionPlan(
  runDir: string,
  executionPlan: ExecutionPlanV1,
  options: MaterializationOptions = {},
): MaterializedExecutionPlan {
  if (executionPlan.tasks.length === 0) {
    materializationError('execution_plan_v1 must contain at least one task before materialization');
  }
  if (!options.methodSpec) {
    materializationError('method_spec with files and run_card is required to materialize executable computation');
  }
  return materializeProviderBackedManifest(runDir, executionPlan, parseProviderBackedMethodBundle(options.methodSpec));
}

export function executionPlanArtifactPath(runDir: string): string {
  return path.join(runDir, 'computation', 'execution_plan_v1.json');
}

export function executionPlanRelativePath(runDir: string): string {
  return toPosixRelative(runDir, executionPlanArtifactPath(runDir));
}
