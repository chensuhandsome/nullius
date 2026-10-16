import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNS_ROOT_RELATIVE } from './run-paths.js';
import { resolveUnderRoot } from './computation/path-safety.js';

/** Run-directory enumeration and the slug family stem — extracted from the
 *  traceability view so the run-index renderer shares ONE definition of
 *  "which run directories exist" and "which family a run id belongs to".
 *  Two definitions of either is how an index disagrees with the status
 *  surface about the same project. */

/** Read locations. Only RUNS_ROOT_RELATIVE admits new execution writes. */
export const RUN_ROOTS = [RUNS_ROOT_RELATIVE, 'team/runs'] as const;

export type RunDirEntry = {
  run_id: string;
  root: string;
  relative_path: string;
  historical: boolean;
  ambiguous: boolean;
};

export type RunDirectoryIssue = { code: string; message: string; path: string };

export class RunDirectoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly count: number | null = null) {
    super(`${code}: ${message}`);
  }
}

function readRunRoot(root: string): fs.Dirent[] | null {
  let metadata: fs.Stats;
  try {
    metadata = fs.lstatSync(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new RunDirectoryError('RUN_ROOT_UNREADABLE', `run root is unreadable: ${root}: ${String(error)}`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()
      || (process.platform !== 'win32' && (!(metadata.mode & 0o444) || !(metadata.mode & 0o111)))) {
    throw new RunDirectoryError('RUN_ROOT_UNREADABLE', `run root must be a readable real directory: ${root}`);
  }
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new RunDirectoryError('RUN_ROOT_UNREADABLE', `run root is unreadable: ${root}: ${String(error)}`);
  }
}

export function readRunDirectoryInventory(projectRoot: string): { runs: RunDirEntry[]; issues: RunDirectoryIssue[] } {
  const runs: RunDirEntry[] = [];
  const issues: RunDirectoryIssue[] = [];
  for (const root of RUN_ROOTS) {
    const historical = root !== RUNS_ROOT_RELATIVE;
    let entries: fs.Dirent[];
    try {
      // Never follow an alias in either component of a read root.
      readRunRoot(path.join(projectRoot, path.dirname(root)));
      entries = readRunRoot(path.join(projectRoot, root)) ?? [];
    } catch (error) {
      if (!historical) throw error;
      issues.push({ code: 'HISTORICAL_RUN_ROOT_UNREADABLE', path: root,
        message: `Historical evidence is unavailable at ${root}: ${String(error)}` });
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        if (!historical) throw new RunDirectoryError('RUN_DIRECTORY_SYMLINK', `${root}/${entry.name} is a symlink; run directories must be real directories.`);
        issues.push({ code: 'HISTORICAL_RUN_DIRECTORY_UNREADABLE', path: `${root}/${entry.name}`,
          message: `Historical run directory must not be a symlink: ${root}/${entry.name}` });
      } else if (entry.isDirectory()) {
        try { readRunRoot(path.join(projectRoot, root, entry.name)); } catch (error) {
          issues.push({ code: 'RUN_DIRECTORY_UNREADABLE', path: `${root}/${entry.name}`, message: String(error) });
          continue;
        }
        runs.push({ run_id: entry.name, root, relative_path: path.posix.join(root, entry.name), historical, ambiguous: false });
      }
    }
  }
  const counts = new Map<string, number>();
  for (const run of runs) counts.set(run.run_id, (counts.get(run.run_id) ?? 0) + 1);
  // Inaccessible payloads still reserve their visible directory identity.
  for (const issue of issues) {
    const root = RUN_ROOTS.find(root => path.posix.dirname(issue.path) === root);
    if (root) {
      const id = path.basename(issue.path);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const run of runs) {
    if ((counts.get(run.run_id) ?? 0) > 1) {
      run.ambiguous = true;
      issues.push({ code: 'RUN_ID_AMBIGUOUS', path: run.relative_path,
        message: `Run id ${run.run_id} exists in multiple roots; select an explicit location for reading.` });
    }
  }
  // Code-point order, never localeCompare: downstream renders are
  // byte-compared for freshness, and locale collation differs across
  // machines' ICU data — identical state must render identical bytes.
  runs.sort((a, b) => a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : a.root < b.root ? -1 : 1);
  issues.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { runs, issues };
}

export function listRunDirectories(projectRoot: string): RunDirEntry[] {
  return readRunDirectoryInventory(projectRoot).runs;
}

/** Resolve evidence without changing its location or admitting execution. */
export function readRunDirFor(projectRoot: string, runId: string, root?: string): string {
  root = root?.replaceAll('\\', '/');
  if (!runId || path.basename(runId) !== runId || runId === '.' || runId === '..') {
    throw new RunDirectoryError('RUN_ID_INVALID', 'run_id must be one path segment');
  }
  if (root !== undefined && !RUN_ROOTS.includes(root as typeof RUN_ROOTS[number])) {
    throw new RunDirectoryError('RUN_ROOT_INVALID', 'read root must be artifacts/runs or team/runs');
  }
  const inventory = readRunDirectoryInventory(projectRoot);
  const matches = inventory.runs.filter(run => run.run_id === runId && (root === undefined || run.root === root));
  if (root === undefined && matches.some(run => run.ambiguous)) throw new RunDirectoryError('RUN_ID_AMBIGUOUS', `Run id ${runId} has multiple locations, including unavailable evidence; select an explicit read root.`);
  if (matches.length > 1) throw new RunDirectoryError('RUN_ID_AMBIGUOUS', `Run id ${runId} exists at ${matches.map(run => run.relative_path).join(', ')}; select an explicit read root.`);
  if (matches.length === 1) return path.join(projectRoot, matches[0]!.relative_path);
  const unavailable = inventory.issues.find(issue => (root === undefined ? RUN_ROOTS.some(candidate => issue.path === path.posix.join(candidate, runId)) : issue.path === path.posix.join(root, runId))
    || issue.path === (root ?? 'team/runs'));
  if (unavailable) throw new RunDirectoryError(unavailable.code, unavailable.message);
  // A not-yet-created canonical run has no evidence; readers can report their
  // usual missing artifact state without creating the directory.
  return path.join(projectRoot, root ?? RUNS_ROOT_RELATIVE, runId);
}

/** Slug stem family (first two hyphen-separated words of the slug, after
 *  stripping the date/milestone/round prefixes): a DISPLAY grouping of an
 *  exploratory chain's many one-off slugs into concept families.
 *  Heuristic, for orientation only; feeds no gate and no validity
 *  decision. */
const SLUG_STEM_FROM_ID = /^(?:\d{8}(?:T\d{6}Z)?)[-_.](?:m\d+-)?(?:r\d+-)?(.+?)(?:-r\d+)?$/;

export function slugFamilyOf(runId: string): string {
  const slug = SLUG_STEM_FROM_ID.exec(runId)?.[1] ?? runId;
  return slug.split('-').slice(0, 2).join('-');
}


/** Original project evidence must never be read through a filesystem alias
 *  below the project root. An absolute value may still spell the root itself
 *  the way the caller spelled it (respelled under the admitted root). */
export function resolveEvidencePath(projectRoot: string, value: string): string {
  const target = resolveUnderRoot(projectRoot, value);
  if (target === null) {
    throw new RunDirectoryError('EVIDENCE_PATH_UNSAFE', 'evidence path escapes the project');
  }
  const relative = path.relative(path.resolve(projectRoot), target);
  let current = projectRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new RunDirectoryError('EVIDENCE_PATH_UNSAFE', `evidence must not be read through a symlink: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  return target;
}
