import { existsSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'path';

export function defaultProjectRoot(rootDir: string): string {
  let current = rootDir;
  while (true) {
    if (existsSync(resolve(current, '.nullius'))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return basename(rootDir) === 'idea-store' ? dirname(rootDir) : rootDir;
}

/**
 * True when `rel`, as `relative` returns it, leaves its base: the parent
 * itself, a path through the parent, or another root. A name that merely
 * begins with two dots (`..notes.json`) stays inside.
 */
export function escapesBase(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

export function insideOrEqual(path: string, root: string): boolean {
  return !escapesBase(relative(root, path));
}

export function encodeProjectPath(path: string): string {
  return path.split(sep).join('/').split('/').map(encodeURIComponent).join('/');
}
