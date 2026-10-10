import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { fileURLToPath } from 'url';
import { assertExternalProjectRoot, invalidParams, respellUnderDirectory, unsafeFs } from '@nullius/shared';
import { isPathInside, resolvePathWithinParent } from './pathGuard.js';

export const HEP_DATA_DIR_ENV = 'HEP_DATA_DIR';
export const HEP_DOWNLOAD_DIR_ENV = 'HEP_DOWNLOAD_DIR';
export const ARXIV_DOWNLOAD_DIR_ENV = 'ARXIV_DOWNLOAD_DIR';
export const WRITING_PROGRESS_DIR_ENV = 'WRITING_PROGRESS_DIR';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.nullius', 'hep-mcp');
const PROJECT_LOCAL_HEP_DATA_DIR = ['artifacts', 'hep-mcp'] as const;
const PROJECT_LOCAL_PDG_DIR = [...PROJECT_LOCAL_HEP_DATA_DIR, 'pdg'] as const;
// The checkout (or installation) this module runs from; a project root must
// lie outside it, as at every other nullius front door.
const INSTALLATION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export type HepDataRootSource = 'project_root' | 'env' | 'scratch';

export interface HepDataRootResolution {
  path: string;
  source: HepDataRootSource;
  project_root?: string;
}

const hepDataRootScope = new AsyncLocalStorage<HepDataRootResolution>();

function expandTilde(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

/**
 * Admit a project root the way the other nullius front doors do: in
 * canonical (symlink-resolved) form, outside any nullius checkout, and
 * initialized. Every directory hep-mcp derives from the root is spelled
 * under this canonical form, so a caller may name the project through any
 * alias and still lands in the same place.
 */
export function admitProjectRoot(rawProjectRoot: unknown): string {
  if (typeof rawProjectRoot !== 'string') {
    throw invalidParams('project_root must be a string path', { project_root: rawProjectRoot });
  }
  const trimmed = rawProjectRoot.trim();
  if (trimmed.length === 0) {
    throw invalidParams('project_root must not be empty');
  }

  const expanded = expandTilde(trimmed);
  if (!path.isAbsolute(expanded)) {
    throw invalidParams('project_root must be an absolute path or tilde-prefixed path', { project_root: rawProjectRoot });
  }

  let root: string;
  try {
    root = assertExternalProjectRoot(expanded, INSTALLATION_ROOT);
  } catch (error) {
    throw invalidParams(`project_root rejected: ${error instanceof Error ? error.message : String(error)}`, {
      project_root: rawProjectRoot,
    });
  }

  const markerDir = path.join(root, '.nullius');
  if (!fs.existsSync(markerDir) || !fs.statSync(markerDir).isDirectory()) {
    throw invalidParams('project_root is not an initialized nullius project', {
      project_root: root,
      required_marker: markerDir,
    });
  }

  return root;
}

/**
 * `<projectRoot>/<segments...>` reached through real directories only. A
 * symlink on any existing component, dangling or not, would place data the
 * project root claims to hold somewhere else, so it is refused; components
 * that do not exist yet are created later as real directories.
 */
function projectContainedDir(projectRoot: string, segments: readonly string[], label: string): string {
  let cursor = projectRoot;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(cursor);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw unsafeFs(`${label} must not traverse a symbolic link below project_root`, {
        project_root: projectRoot,
        symlink_path: cursor,
      });
    }
  }
  return path.join(projectRoot, ...segments);
}

/** HEP data directory of an admitted project root. */
export function projectHepDataDir(projectRoot: string): string {
  return projectContainedDir(projectRoot, PROJECT_LOCAL_HEP_DATA_DIR, 'HEP data dir');
}

/** PDG data directory of an admitted project root. */
export function projectPdgDataDir(projectRoot: string): string {
  return projectContainedDir(projectRoot, PROJECT_LOCAL_PDG_DIR, 'PDG data dir');
}

/**
 * HEP data directory for an admin tool: the project's own unless the caller
 * overrides it. An override naming a location inside the project, spelled
 * directly or through an alias of the root, is a project directory like the
 * derived one: re-spelled under the canonical root and reached through real
 * directories only. An override outside the project is an independent data
 * root chosen explicitly by the caller, as `HEP_DATA_DIR` is.
 */
export function resolveAdminHepDataRoot(projectRoot: string, override?: string): string {
  if (override === undefined) return projectHepDataDir(projectRoot);
  // An explicit override, blank included, must name a directory; it never
  // falls back to the project's own data root.
  const expanded = expandTilde(override);
  if (!path.isAbsolute(expanded)) {
    throw invalidParams('hep_data_root must be an absolute path or tilde-prefixed path', { hep_data_root: override });
  }
  const resolved = path.resolve(expanded);
  const underRoot = isPathInside(projectRoot, resolved) ? resolved : respellUnderDirectory(projectRoot, resolved);
  if (underRoot === null) return resolved;
  const relative = path.relative(projectRoot, underRoot);
  return projectContainedDir(projectRoot, relative === '' ? [] : relative.split(path.sep), 'hep_data_root');
}

function normalizeProjectRoot(rawProjectRoot: unknown): string | undefined {
  if (rawProjectRoot === undefined || rawProjectRoot === null) return undefined;
  return admitProjectRoot(rawProjectRoot);
}

export function resolveHepDataRoot(projectRoot?: unknown): HepDataRootResolution {
  const normalizedProjectRoot = normalizeProjectRoot(projectRoot);
  if (normalizedProjectRoot) {
    return {
      path: projectHepDataDir(normalizedProjectRoot),
      source: 'project_root',
      project_root: normalizedProjectRoot,
    };
  }

  const configured = process.env[HEP_DATA_DIR_ENV];
  if (configured && configured.trim().length > 0) {
    return {
      path: path.resolve(expandTilde(configured)),
      source: 'env',
    };
  }

  return {
    path: path.resolve(DEFAULT_DATA_DIR),
    source: 'scratch',
  };
}

export function getDataRootInfo(): HepDataRootResolution {
  return hepDataRootScope.getStore() ?? resolveHepDataRoot();
}

export async function withHepDataRoot<T>(projectRoot: unknown, fn: () => Promise<T>): Promise<T> {
  if ((projectRoot === undefined || projectRoot === null) && hepDataRootScope.getStore()) {
    return fn();
  }
  return hepDataRootScope.run(resolveHepDataRoot(projectRoot), fn);
}

export function getDataDir(): string {
  return getDataRootInfo().path;
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    return;
  }
  const stat = fs.statSync(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

export function getCacheDir(): string {
  return path.join(getDataDir(), 'cache');
}

export function getWritingProgressDir(): string {
  const root = getDataRootInfo();
  const dataDir = root.path;
  const candidate = root.source === 'project_root'
    ? path.join(dataDir, 'writing_progress')
    : expandTilde(process.env[WRITING_PROGRESS_DIR_ENV] || path.join(dataDir, 'writing_progress'));
  return resolvePathWithinParent(dataDir, candidate, WRITING_PROGRESS_DIR_ENV);
}

export function getDownloadsDir(): string {
  const root = getDataRootInfo();
  const dataDir = root.path;
  const candidate =
    root.source === 'project_root'
      ? path.join(dataDir, 'downloads')
      : process.env[HEP_DOWNLOAD_DIR_ENV] ||
        process.env[ARXIV_DOWNLOAD_DIR_ENV] ||
        path.join(dataDir, 'downloads');
  return resolvePathWithinParent(dataDir, expandTilde(candidate), 'downloads dir');
}
