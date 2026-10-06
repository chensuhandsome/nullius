import * as fs from 'node:fs';
import * as path from 'node:path';
import { TextDecoder } from 'node:util';

/** Resolve the existing ancestor before appending uncreated path segments. */
export function canonicalProjectPath(value: string): string {
  let current = path.resolve(value);
  const tail: string[] = [];
  for (;;) {
    try { fs.lstatSync(current); return path.join(fs.realpathSync.native(current), ...tail.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current)); current = parent;
    }
  }
}

function inside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return true;
  // Directory identity also covers case aliases on case-insensitive filesystems.
  if (!fs.existsSync(base)) return false;
  const target = fs.statSync(base);
  for (let current = candidate; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const actual = fs.statSync(current);
      if (actual.dev === target.dev && actual.ino === target.ino) return true;
    }
    if (path.dirname(current) === current) return false;
  }
}

function packageName(directory: string): string | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(path.join(directory, 'package.json'))));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && 'name' in value && typeof value.name === 'string' ? value.name : null;
  } catch (error) {
    throw new Error('project root has ambiguous development-checkout metadata', { cause: error });
  }
}

function markerPresent(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false;
    throw new Error('project root has ambiguous development-checkout metadata', { cause: error });
  }
}

/** Recognize other checkouts; malformed identity in a matching layout cannot grant admission. */
function developmentCheckoutRoot(root: string): string | null {
  for (let current = root; ; current = path.dirname(current)) {
    const markers = ['pnpm-workspace.yaml', 'package.json', 'packages/orchestrator/package.json', 'packages/shared/package.json'];
    if (markers.every(marker => markerPresent(path.join(current, marker)))) {
      const rootName = packageName(current);
      const orchestratorName = packageName(path.join(current, 'packages/orchestrator'));
      const sharedName = packageName(path.join(current, 'packages/shared'));
      if (rootName === 'nullius' || (orchestratorName === '@nullius/orchestrator' && sharedName === '@nullius/shared')) return current;
    }
    if (path.dirname(current) === current) return null;
  }
}

export function assertExternalProjectRoot(value: string, installationRoot: string, policy = 'real_project'): string {
  if (!['real_project', 'maintainer_fixture'].includes(policy)) throw new Error('invalid project policy');
  const root = canonicalProjectPath(value);
  const installation = canonicalProjectPath(installationRoot);
  if (root === path.parse(root).root || inside(root, installation)) {
    throw new Error('project root must name a specific external directory, not the installation or an ancestor');
  }
  if (inside(installation, root)) {
    const fixture = canonicalProjectPath(path.join(installation, 'skills/research-team/.tmp'));
    if (policy !== 'maintainer_fixture' || !inside(fixture, root)) {
      throw new Error('project root must resolve outside the nullius dev repo; only the explicit maintainer_fixture directory is permitted');
    }
  }
  const checkout = developmentCheckoutRoot(root);
  if (checkout !== null) {
    const fixture = canonicalProjectPath(path.join(checkout, 'skills/research-team/.tmp'));
    if (policy !== 'maintainer_fixture' || !inside(fixture, root)) {
      throw new Error('project root must resolve outside the nullius dev repo; only the explicit maintainer_fixture directory is permitted');
    }
  }
  return root;
}
