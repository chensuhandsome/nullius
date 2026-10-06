import * as fs from 'node:fs';
import * as path from 'node:path';
import { RUNS_ROOT_RELATIVE } from './run-paths.js';

/** Run-directory enumeration and the slug family stem — extracted from the
 *  traceability view so the run-index renderer shares ONE definition of
 *  "which run directories exist" and "which family a run id belongs to".
 *  Two definitions of either is how an index disagrees with the status
 *  surface about the same project. */

export const RUN_ROOTS = [RUNS_ROOT_RELATIVE] as const;

export type RunDirEntry = {
  run_id: string;
};

export class RunDirectoryError extends Error {
  constructor(public readonly code: string, message: string, public readonly count: number | null = null) {
    super(message);
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
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !(metadata.mode & 0o444) || !(metadata.mode & 0o111)) {
    throw new RunDirectoryError('RUN_ROOT_UNREADABLE', `run root must be a readable real directory: ${root}`);
  }
  try {
    return fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new RunDirectoryError('RUN_ROOT_UNREADABLE', `run root is unreadable: ${root}: ${String(error)}`);
  }
}

/** Refusal only: old executor payloads are never treated as another run root. */
export function assertNoRetiredRunRoot(projectRoot: string): void {
  // Inspect the parent too: lstat on runs alone would follow a team alias.
  readRunRoot(path.join(projectRoot, 'team'));
  const root = path.join(projectRoot, 'team', 'runs');
  let entries: fs.Dirent[] | null;
  try {
    entries = readRunRoot(root);
  } catch (error) {
    throw new RunDirectoryError('RETIRED_RUN_ROOT_UNREADABLE', `retired team/runs root cannot be inspected: ${String(error)}`);
  }
  const count = entries?.filter(entry => entry.isDirectory()).length ?? 0;
  const symlinks = entries?.filter(entry => entry.isSymbolicLink()).length ?? 0;
  if (count || symlinks) {
    throw new RunDirectoryError('RETIRED_RUN_ROOT',
      `retired team/runs root contains ${count} run directories${symlinks ? ` and ${symlinks} symlink entries` : ''}; `
      + 'retain the prior runtime with its matching skills, or perform a separately reviewed migration before switching.', count);
  }
}

export function listRunDirectories(projectRoot: string): RunDirEntry[] {
  assertNoRetiredRunRoot(projectRoot);
  readRunRoot(path.join(projectRoot, 'artifacts'));
  const entries = readRunRoot(path.join(projectRoot, RUNS_ROOT_RELATIVE)) ?? [];
  if (entries.some(entry => entry.isSymbolicLink())) {
    throw new RunDirectoryError('RUN_DIRECTORY_SYMLINK', 'artifacts/runs contains a symlink; run directories must be real directories.');
  }
  // Code-point order, never localeCompare: downstream renders are
  // byte-compared for freshness, and locale collation differs across
  // machines' ICU data — identical state must render identical bytes.
  return entries.filter(entry => entry.isDirectory()).map(entry => ({ run_id: entry.name }))
    .sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0));
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
