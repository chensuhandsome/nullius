import * as fs from 'fs';
import * as path from 'path';

/** Read a file a tool reported by its project-relative path. */
export function readProjectFile(projectRoot: string, projectRelativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, ...projectRelativePath.split('/')), 'utf-8');
}

/** A minimal initialized nullius project root (a `.nullius/` marker) inside `parent`. */
export function makeProjectRoot(parent: string, name = 'project'): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
  return root;
}
