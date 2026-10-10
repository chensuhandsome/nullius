import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * A temporary project root as the admin tools admit it: canonical
 * (symlink-resolved) and initialized, so reports name it exactly as spelled
 * here on every host, including macOS where the temp directory is an alias.
 */
export function makeInitializedProjectRoot(prefix: string): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  fs.mkdirSync(path.join(root, '.nullius'));
  return root;
}
