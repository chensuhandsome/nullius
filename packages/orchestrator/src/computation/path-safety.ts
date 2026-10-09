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

export function resolveWithinRoot(rootPath: string, candidatePath: string, label: string): string {
  const root = path.resolve(rootPath);
  const resolved = path.resolve(path.isAbsolute(candidatePath) ? candidatePath : path.join(root, candidatePath));
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeFs(`${label} must stay within ${root}`, { label, root_path: root, target_path: target });
  }
  const segments = relative === '' ? [] : relative.split(path.sep);
  let cursor = root;
  const rootsToCheck = [root, ...segments.map((segment) => {
    cursor = path.join(cursor, segment);
    return cursor;
  })];
  for (const [index, candidate] of rootsToCheck.entries()) {
    if (!fs.existsSync(candidate)) {
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

export function sanitizeRelativePath(relativePath: string, label: string): string {
  const normalized = relativePath.trim();
  if (!normalized) {
    throw unsafeFs(`${label} cannot be empty`, { label });
  }
  if (normalized.includes('\0') || normalized.includes('..')) {
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
