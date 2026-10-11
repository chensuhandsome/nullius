import * as fs from 'node:fs';
import * as path from 'node:path';
import { blockedCommand, unsafeFs } from '@nullius/shared';
import type { ManifestTool } from './types.js';

const BLOCKED_COMMAND_PATTERNS = [
  { pattern: /(?:^|\s)rm\s+-rf\s+\/(?:\s|$)/i, reason: 'rm -rf /' },
  { pattern: /curl\s*\|\s*sh/i, reason: 'curl | sh' },
  { pattern: /chmod\s+777(?:\s|$)/i, reason: 'chmod 777' },
  { pattern: />\s*\/dev\//i, reason: '> /dev/' },
  { pattern: /(?:^|\s)ncat?(?:\s|$)/i, reason: 'nc/ncat' },
];

/**
 * True when `relative`, as `path.relative` returns it, leaves its base: the
 * parent itself, a path through the parent, or another root. A name that
 * merely begins with two dots (`..notes.md`) stays inside.
 */
export function escapesBase(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * `candidatePath` spelled under `rootPath` when it names a location inside
 * the root, else null. A relative candidate resolves against the root and
 * must stay inside it as spelled. An absolute candidate may also reach the
 * root through an alias above it (respellUnderRoot): the root is admitted in
 * canonical form, while a caller may spell paths through the alias it used
 * for the root. Components below the root are kept verbatim, so the caller's
 * symlink check still sees every one of them. A root that does not exist has
 * no identity to recognize, so only its own spelling is accepted then.
 */
export function resolveUnderRoot(rootPath: string, candidatePath: string): string | null {
  const root = path.resolve(rootPath);
  const lexical = path.resolve(root, candidatePath);
  if (!escapesBase(path.relative(root, lexical))) return lexical;
  return path.isAbsolute(candidatePath) ? respellUnderRoot(root, lexical) : null;
}

export function resolveWithinRoot(rootPath: string, candidatePath: string, label: string): string {
  const root = path.resolve(rootPath);
  const resolved = resolveUnderRoot(root, candidatePath);
  if (resolved === null) {
    throw unsafeFs(`${label} must stay within ${root}`, { label, root_path: root, candidate_path: candidatePath });
  }
  return resolved;
}

/**
 * Lexical containment is insufficient for provenance: a symlink below the
 * workspace can redirect an apparently local script, input, or output to
 * unrelated bytes.  Walk every existing component and reject symlinks before
 * execution or receipt construction.
 */
export function assertNoSymlinkComponents(
  rootPath: string,
  targetPath: string,
  label: string,
  options: { allowMissingLeaf?: boolean } = {},
): void {
  const root = path.resolve(rootPath);
  const target = resolveUnderRoot(root, path.resolve(targetPath));
  if (target === null) {
    throw unsafeFs(`${label} must stay within ${root}`, { label, root_path: root, target_path: path.resolve(targetPath) });
  }
  const relative = path.relative(root, target);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let cursor = root;
  const rootsToCheck = [root, ...segments.map((segment) => {
    cursor = path.join(cursor, segment);
    return cursor;
  })];
  for (const [index, candidate] of rootsToCheck.entries()) {
    // lstat, not existsSync: a dangling symlink is an entry that redirects
    // whatever is later created through it.
    if (!entryExists(candidate)) {
      const isLeaf = index === rootsToCheck.length - 1;
      if (isLeaf && options.allowMissingLeaf) return;
      // A missing intermediate directory is safe at this point; later output
      // creation is checked again before the artifact is accepted.
      return;
    }
    if (fs.lstatSync(candidate).isSymbolicLink()) {
      throw unsafeFs(`${label} must not traverse a symbolic link`, {
        label,
        root_path: root,
        symlink_path: candidate,
      });
    }
  }
}

/** Highest existing ancestor of `target` that is the same directory as `root`, or null. */
function rootAliasAncestor(root: string, target: string): string | null {
  const identity = fs.statSync(root);
  let boundary: string | null = null;
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    if (fs.existsSync(cursor)) {
      const actual = fs.statSync(cursor);
      if (actual.dev === identity.dev && actual.ino === identity.ino) boundary = cursor;
    }
    if (path.dirname(cursor) === cursor) break;
  }
  return boundary;
}

/**
 * Re-spell an absolute path that reaches `rootPath` through an alias above it
 * (a symlinked ancestor, or another spelling of the same directory) under
 * `rootPath` itself; null when no ancestor of the path is that directory.
 * Components below the root are kept verbatim, so the caller's own symlink
 * check still sees every one of them.
 */
export function respellUnderRoot(rootPath: string, targetPath: string): string | null {
  const root = path.resolve(rootPath);
  if (!fs.existsSync(root)) return null;
  const target = path.resolve(targetPath);
  const boundary = rootAliasAncestor(root, target);
  return boundary === null ? null : path.join(root, path.relative(boundary, target));
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

/**
 * Where `targetPath` really is: its deepest existing entry resolved through
 * every symlink, with the components that do not exist yet appended. A
 * dangling symlink on the way leaves the location undetermined and throws.
 */
export function realLocation(targetPath: string): string {
  const target = path.resolve(targetPath);
  let existing = target;
  while (!entryExists(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  let real: string;
  try {
    real = fs.realpathSync.native(existing);
  } catch (error) {
    throw unsafeFs(`cannot determine where ${target} lands: ${existing} does not resolve (a dangling symlink?)`, {
      target_path: target,
      unresolved_path: existing,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return path.join(real, path.relative(existing, target));
}

/**
 * Whether `targetPath` names `dirPath` or a location inside it under either
 * reading: as spelled, or where it really is. For guards that must keep a
 * path OUT of a directory, where a missed overlap is the unsafe direction:
 * the directory is recognized by identity among the ancestors of the real
 * location, so no alias above it, symlink below it, or other spelling of it
 * (letter case on a case-insensitive filesystem included) hides an overlap.
 * A directory that does not exist yet has no identity, so it is compared by
 * the spelling of the two real locations instead. Throws when the target's
 * real location cannot be determined.
 */
export function realLocationWithin(dirPath: string, targetPath: string): boolean {
  const dir = path.resolve(dirPath);
  const target = path.resolve(targetPath);
  if (!escapesBase(path.relative(dir, target))) return true;
  const real = realLocation(target);
  if (!fs.existsSync(dir)) return !escapesBase(path.relative(realLocation(dir), real));
  return rootAliasAncestor(dir, real) !== null;
}

/** Normalize aliases above the admitted project boundary, while refusing symlinks below it. */
export function resolveProjectContainedPath(rootPath: string, targetPath: string, label: string): string {
  const root = fs.realpathSync.native(rootPath);
  const target = path.resolve(targetPath);
  const boundary = rootAliasAncestor(root, target);
  if (boundary === null) throw unsafeFs(`${label} must stay within ${root}`, { label, target_path: target });
  const relative = path.relative(boundary, target);
  let cursor = boundary;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) throw unsafeFs(`${label} must not traverse a symbolic link`, { label, symlink_path: cursor });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path.join(root, relative);
}

/**
 * A workspace path as a manifest or method spec gives it: refused when empty,
 * when it contains NUL, or when any of its segments (split at either slash)
 * is `..`. A name that merely contains two dots (`..data.csv`) is an ordinary
 * file name. Every caller still resolves the result under its root and
 * refuses symbolic links on the way.
 */
export function sanitizeRelativePath(relativePath: string, label: string): string {
  const normalized = relativePath.trim();
  if (!normalized) {
    throw unsafeFs(`${label} cannot be empty`, { label });
  }
  if (normalized.includes('\0') || normalized.split(/[\\/]/).includes('..')) {
    throw unsafeFs(`${label} contains unsafe path traversal`, { label, path: relativePath });
  }
  return normalized;
}

export function runtimeTokenForTool(tool: ManifestTool): string {
  if (tool === 'python') return 'python3';
  if (tool === 'bash') return 'bash';
  if (tool === 'julia') return 'julia';
  return 'wolframscript';
}

export function buildToolCommand(
  tool: ManifestTool,
  scriptPath: string,
  args: string[],
  runtimePath = runtimeTokenForTool(tool),
): string[] {
  if (tool === 'mathematica') return [runtimePath, '-file', scriptPath, ...args];
  return [runtimePath, scriptPath, ...args];
}

export function assertCommandAllowed(argv: string[]): void {
  const command = argv.join(' ');
  for (const entry of BLOCKED_COMMAND_PATTERNS) {
    if (entry.pattern.test(command)) {
      throw blockedCommand(`Blocked command detected: ${entry.reason}`, {
        blocked_pattern: entry.reason,
        command,
      });
    }
  }
}
