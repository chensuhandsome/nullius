import * as path from 'node:path';
import * as fs from 'node:fs';

/** The canonical run root, relative to the project root. Every run the
 *  control plane creates by default lives here — it is the
 *  stampable run root, so a front-door run is visible to the traceability
 *  read model and receives its automatic launch stamp. */
export const RUNS_ROOT_RELATIVE = path.join('artifacts', 'runs');

/** Prefix of the error a bridge tool maps to an environment (unsafe_fs) failure rather than a caller error. */
export const HISTORICAL_RUN_UNAVAILABLE_PREFIX = 'HISTORICAL_RUN_UNAVAILABLE';

/** Execution admission, including identity collisions with read-only history. */
export function assertWritableRunId(projectRoot: string, runId: string): void {
  if (!runId || path.basename(runId) !== runId || runId === '.' || runId === '..') throw new Error('RUN_ID_INVALID: run_id must be one path segment');
  const historical = path.join(projectRoot, 'team', 'runs', runId);
  try {
    fs.lstatSync(historical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(`${HISTORICAL_RUN_UNAVAILABLE_PREFIX}: cannot inspect ${historical}: ${String(error)}`);
  }
  throw new Error(`HISTORICAL_RUN_READ_ONLY: ${historical} already owns run id ${runId}; use a distinct id for new execution.`);
}

/** Canonical write path. Evidence readers use readRunDirFor instead. */
export function runDirFor(projectRoot: string, runId: string): string {
  assertWritableRunId(projectRoot, runId);
  return path.join(projectRoot, RUNS_ROOT_RELATIVE, runId);
}


/** Reject historical execution targets even through an alias. For staging
 *  APIs without project_root, infer identity from an established run root. */
export function assertExecutionRunDirectory(runDir: string, projectRoot?: string, runId?: string): void {
  assertOutsideHistoricalRuns(runDir);
  const lexical = path.resolve(runDir);
  for (const candidate of [lexical, resolveWriteTarget(lexical)]) {
    const parts = candidate.split(path.sep);
    const folded = parts.map(part => part.toLowerCase());
    for (let index = 0; index < folded.length - 2; index += 1) {
      if (folded[index] !== 'artifacts' || folded[index + 1] !== 'runs') continue;
      const managedRoot = parts.slice(0, index).join(path.sep) || path.sep;
      const directoryId = parts[index + 2]!;
      assertWritableRunId(managedRoot, directoryId);
      if (runId && runId !== directoryId) throw new Error('RUN_ID_MISMATCH: managed run directory and declared run id must agree');
    }
  }
  if (projectRoot) assertWritableRunId(projectRoot, runId ?? path.basename(lexical));
}

/** Exports and other derived outputs cannot overwrite historical evidence. */
export function assertOutsideHistoricalRuns(target: string): void {
  const lexical = path.resolve(target);
  const actual = resolveWriteTarget(lexical);
  for (const candidate of [lexical, actual]) {
    const parts = candidate.toLowerCase().split(path.sep);
    if (parts.some((part, index) => part === 'team' && parts[index + 1] === 'runs')) {
      throw new Error(`HISTORICAL_RUN_READ_ONLY: execution cannot write historical evidence at ${target}`);
    }
  }
}

function resolveWriteTarget(lexical: string): string {
  let existing = lexical;
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  return path.join(fs.realpathSync(existing), path.relative(existing, lexical));
}
