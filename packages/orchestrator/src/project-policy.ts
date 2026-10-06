import * as os from 'node:os';
import { assertExternalProjectRoot } from '@nullius/shared';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_POLICY_REAL_PROJECT = 'real_project';

function devRepoRoot(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(moduleDir, '../../..');
}

export function resolveUserPath(rawPath: string, base: string): string {
  const expanded = rawPath === '~'
    ? os.homedir()
    : rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
  return path.resolve(base, expanded);
}

export function assertProjectRootAllowed(
  projectRoot: string,
  policy = PROJECT_POLICY_REAL_PROJECT,
  repoRoot = devRepoRoot(),
): string {
  return assertExternalProjectRoot(projectRoot, repoRoot, policy);
}
