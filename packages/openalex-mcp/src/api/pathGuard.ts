/**
 * Containment checks for paths this package writes under its data dir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { invalidParams } from '@nullius/shared';

// Exact escape test: the parent itself, a path through the parent, or another
// root. A name that merely begins with two dots (`..downloads`) stays inside.
function isPathInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate);
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

export function guardPath(parentDir: string, candidatePath: string, what: string): string {
  const resolvedParent = path.resolve(parentDir);
  const resolvedCandidate = path.resolve(candidatePath);
  if (!isPathInside(resolvedParent, resolvedCandidate)) {
    throw invalidParams(`${what} must be within ${resolvedParent}`);
  }
  // Walk from candidate upward to find the deepest existing path component,
  // then compare where it really lands with where the parent really is. This
  // catches symlinks in intermediate ancestors that point outside the parent
  // (e.g. dataDir/link/subdir where link → /etc), while a parent reached
  // through a link (dataDir/link/sub where link → dataDir/real, or a data dir
  // under /var → /private/var) still contains its own existing entries.
  let check = resolvedCandidate;
  while (check !== resolvedParent && check !== path.dirname(check)) {
    if (fs.existsSync(check)) {
      let realParent: string;
      let real: string;
      try {
        realParent = fs.realpathSync(resolvedParent);
        real = fs.realpathSync(check);
      } catch {
        throw invalidParams(`${what}: cannot resolve the real location of ${check}`);
      }
      if (!isPathInside(realParent, real)) {
        throw invalidParams(`${what}: symlink escape detected`);
      }
      break; // deepest existing component is safe; ancestors towards parent are pre-approved
    }
    check = path.dirname(check);
  }
  return resolvedCandidate;
}
