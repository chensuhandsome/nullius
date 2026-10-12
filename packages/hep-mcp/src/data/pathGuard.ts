import * as fs from 'fs';
import * as path from 'path';
import { respellUnderDirectory, unsafeFs } from '@nullius/shared';

function isOutsideOf(parentDir: string, candidatePath: string): boolean {
  const relative = path.relative(parentDir, candidatePath);
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

export function isPathInside(parentDir: string, candidatePath: string): boolean {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (resolvedParent === resolvedCandidate) return true;
  if (isOutsideOf(resolvedParent, resolvedCandidate)) return false;
  return !path.isAbsolute(path.relative(resolvedParent, resolvedCandidate));
}

function entryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

function realPathOrRefuse(entryPath: string, candidatePath: string, what: string): string {
  try {
    return fs.realpathSync(entryPath);
  } catch (error) {
    throw unsafeFs(`${what}: cannot determine where ${candidatePath} lands; ${entryPath} does not resolve (a dangling symlink?)`, {
      candidate_path: candidatePath,
      unresolved_path: entryPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `dirPath` itself when it exists, else its nearest existing ancestor. */
function nearestExistingDirectory(dirPath: string): string {
  let current = dirPath;
  while (!fs.existsSync(current) && path.dirname(current) !== current) current = path.dirname(current);
  return current;
}

/**
 * Resolve `userPath` to a location inside `parentDir`, spelled under
 * `parentDir`. A relative path resolves against the parent and must stay
 * inside it as spelled. An absolute path may also reach the parent through an
 * alias above it — the project root is admitted in canonical form while a
 * caller may spell paths through the alias it knows the project by — and is
 * then re-spelled under the parent. The parent is recognized by directory
 * identity at its nearest existing level, so a data directory that is not
 * created yet is still recognized through its existing ancestor. Components
 * below that level are kept verbatim for the symlink check that follows.
 *
 * The check is relative to `parentDir`, which is trusted: it must be an
 * admitted data root or a directory obtained through this function from
 * one (or otherwise verified to be a real directory). A parent that does not
 * exist has nothing below it to check, so a parent spelled through a
 * symlink must have been refused where it was derived.
 */
export function resolvePathWithinParent(
  parentDir: string,
  userPath: string,
  what: string
): string {
  const resolvedParent = path.resolve(parentDir);
  const lexicalCandidate = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(resolvedParent, userPath);

  let resolvedCandidate = lexicalCandidate;
  if (!isPathInside(resolvedParent, lexicalCandidate)) {
    const respelled = path.isAbsolute(userPath)
      ? respellUnderDirectory(nearestExistingDirectory(resolvedParent), lexicalCandidate)
      : null;
    if (respelled === null || !isPathInside(resolvedParent, respelled)) {
      throw unsafeFs(`${what} must be within ${resolvedParent}`, {
        parent_dir: resolvedParent,
        candidate_path: lexicalCandidate,
      });
    }
    resolvedCandidate = respelled;
  }

  // Defense-in-depth: block symlink escapes.
  // If a path component inside `resolvedParent` is a symlink pointing outside,
  // `path.resolve()` + string-based checks are insufficient. Entries are found
  // with lstat, so a dangling symlink counts as present: it would redirect
  // whatever is later created through it, and since where it lands cannot be
  // determined it is refused rather than judged by its spelling.
  if (entryExists(resolvedParent)) {
    const realParent = realPathOrRefuse(resolvedParent, resolvedCandidate, what);

    // Resolve the nearest existing entry of the candidate to validate realpath containment.
    let existing = resolvedCandidate;
    while (!entryExists(existing)) {
      const next = path.dirname(existing);
      if (next === existing) break;
      existing = next;
    }
    const realExisting = realPathOrRefuse(existing, resolvedCandidate, what);

    if (!isPathInside(realParent, realExisting)) {
      throw unsafeFs(`${what} must be within ${realParent}`, {
        parent_dir: realParent,
        candidate_path: resolvedCandidate,
        existing_path: existing,
        existing_realpath: realExisting,
      });
    }
  }

  return resolvedCandidate;
}
