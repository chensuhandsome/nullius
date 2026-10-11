import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { commitStagedDurable, invalidParams, respellUnderDirectory, unsafeFs, writeBytesAtomicDurable } from '@nullius/shared';

import { getDataRootInfo } from '../data/dataDir.js';
import { isPathInside } from '../data/pathGuard.js';
import { assertSafePathSegment } from './paths.js';

/**
 * A directory inside the admitted project root where a tool writes its
 * outputs. The caller names it; hep-mcp keeps no run of its own.
 */
export interface OutputDir {
  /** Admitted (canonical) project root. */
  projectRoot: string;
  /** The output directory, spelled under `projectRoot`. */
  dir: string;
  /** The output directory relative to `projectRoot`, with `/` separators. */
  relative: string;
}

/** A file a tool wrote into its output directory. */
export interface OutputArtifactRef {
  /** File name within the output directory (`external_api/<file>` for API records). */
  name: string;
  /** Path relative to the project root, with `/` separators. */
  path: string;
  mimeType: string;
}

/** Subdirectory of an output directory holding per-call external API records. */
export const EXTERNAL_API_SUBDIR = 'external_api';

// Locations an output directory may not lie in: the project's control state,
// historical runs (read-only evidence), and hep-mcp's own data directory,
// whose historical runs are evidence too. Compared case-insensitively.
const RESERVED_PREFIXES: readonly (readonly string[])[] = [
  ['.nullius'],
  ['team', 'runs'],
  ['artifacts', 'hep-mcp'],
];

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

function lstatOrNull(entry: string): fs.Stats | null {
  try {
    return fs.lstatSync(entry);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Make `<base>/<segments...>` exist through real directories only. A symlink
 * on any component, dangling or not, would place outputs the project claims
 * to hold somewhere else, so it is refused; a missing component is created as
 * a real directory.
 */
function realDirectoryChain(
  base: string,
  segments: readonly string[],
  label: string,
  projectRoot: string,
  create = true,
): void {
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    let stat = lstatOrNull(cursor);
    if (stat === null && !create) {
      throw unsafeFs(`${label} is missing`, { project_root: projectRoot, path: cursor });
    }
    if (stat === null) {
      try {
        fs.mkdirSync(cursor);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      stat = lstatOrNull(cursor);
    }
    if (stat === null) {
      throw unsafeFs(`${label} could not be created`, { project_root: projectRoot, path: cursor });
    }
    if (stat.isSymbolicLink()) {
      throw unsafeFs(`${label} must not traverse a symbolic link below project_root`, {
        project_root: projectRoot,
        symlink_path: cursor,
      });
    }
    if (!stat.isDirectory()) {
      throw unsafeFs(`${label} must name a directory`, { project_root: projectRoot, path: cursor });
    }
  }
}

/**
 * Resolve the caller's `output_dir` inside the project root of this call and
 * create it. A relative path resolves against the project root and must stay
 * inside it as spelled; an absolute path may also reach the root through an
 * alias above it (the root is admitted in canonical form) and is re-spelled
 * under the root. Below the root, every component must be a real directory.
 */
export function resolveOutputDir(rawOutputDir: string): OutputDir {
  const root = getDataRootInfo();
  if (root.source !== 'project_root' || !root.project_root) {
    throw invalidParams('output_dir requires project_root: outputs are written inside the project that the call names', {
      output_dir: rawOutputDir,
    });
  }
  const projectRoot = root.project_root;
  if (typeof rawOutputDir !== 'string' || rawOutputDir.trim().length === 0 || rawOutputDir.includes('\0')) {
    throw invalidParams('output_dir must name a directory inside project_root', { output_dir: rawOutputDir });
  }

  const lexical = path.isAbsolute(rawOutputDir)
    ? path.resolve(rawOutputDir)
    : path.resolve(projectRoot, rawOutputDir);
  const underRoot = isPathInside(projectRoot, lexical)
    ? lexical
    : path.isAbsolute(rawOutputDir) ? respellUnderDirectory(projectRoot, lexical) : null;
  if (underRoot === null || !isPathInside(projectRoot, underRoot)) {
    throw unsafeFs('output_dir must lie inside project_root', {
      project_root: projectRoot,
      output_dir: rawOutputDir,
    });
  }

  const relative = path.relative(projectRoot, underRoot);
  if (relative === '') {
    throw invalidParams('output_dir must name a directory inside project_root, not the root itself', {
      project_root: projectRoot,
      output_dir: rawOutputDir,
    });
  }
  const segments = relative.split(path.sep);
  const folded = segments.map(segment => segment.toLowerCase());
  for (const reserved of RESERVED_PREFIXES) {
    if (reserved.every((segment, index) => folded[index] === segment)) {
      throw unsafeFs(`output_dir must not lie under ${reserved.join('/')}/`, {
        project_root: projectRoot,
        output_dir: rawOutputDir,
      });
    }
  }

  realDirectoryChain(projectRoot, segments, 'output_dir', projectRoot);
  return { projectRoot, dir: underRoot, relative: toPosix(relative) };
}

/**
 * Absolute path of the output file `name`: one safe file name, or
 * `external_api/<file name>`. The whole directory chain from the project
 * root is checked again on every call, so a component swapped for a
 * symlink after admission is refused before each write rather than only at
 * admission. An existing entry at the file itself must be a regular file,
 * never a symlink that would redirect the write. (A swap in the instant
 * between this check and the write is not excluded: Node offers no
 * directory-descriptor-relative open or rename.)
 */
export function outputFilePath(out: OutputDir, name: string): string {
  const parts = name.split('/');
  if (parts.length > 2 || (parts.length === 2 && parts[0] !== EXTERNAL_API_SUBDIR)) {
    throw invalidParams('output artifact name must be one file name', { artifact_name: name });
  }
  for (const part of parts) assertSafePathSegment(part, 'artifact_name');
  const chain = [...out.relative.split('/'), ...parts.slice(0, -1)];
  realDirectoryChain(out.projectRoot, chain, 'output_dir', out.projectRoot);

  const file = path.join(out.dir, ...parts);
  const stat = lstatOrNull(file);
  if (stat !== null && (stat.isSymbolicLink() || !stat.isFile())) {
    throw unsafeFs('output file must not be a symbolic link or a non-file entry', {
      project_root: out.projectRoot,
      path: file,
    });
  }
  return file;
}

export function outputArtifactRef(out: OutputDir, name: string, mimeType: string): OutputArtifactRef {
  return { name, path: `${out.relative}/${name}`, mimeType };
}

/**
 * Write serialized bytes: the path is checked right before the temporary
 * file is opened and again right before it replaces the target.
 */
function writeOutputBytes(out: OutputDir, name: string, bytes: string): void {
  const file = outputFilePath(out, name);
  writeBytesAtomicDurable(file, bytes, undefined, () => {
    outputFilePath(out, name);
  });
}

export function writeOutputJson(out: OutputDir, name: string, data: unknown): OutputArtifactRef {
  // Serialize first, so no time-consuming step separates the check from the write.
  writeOutputBytes(out, name, JSON.stringify(data, null, 2));
  return outputArtifactRef(out, name, 'application/json');
}

export function writeOutputJsonl(out: OutputDir, name: string, rows: unknown[]): OutputArtifactRef {
  const body = rows.map(row => JSON.stringify(row)).join('\n');
  writeOutputBytes(out, name, rows.length > 0 ? `${body}\n` : '');
  return outputArtifactRef(out, name, 'application/x-ndjson');
}

/**
 * A streamed output file. Bytes go to a temporary file beside the target,
 * which is flushed to disk and then replaces the target only on `commit`;
 * `abort` removes it. A stream error at any time (opening, writing, or
 * finishing) is held until `commit`, which then rejects with it. On every
 * failure path the temporary file is removed, provided it is still the file
 * this stream created, reached through the same real directories; if the
 * directory was swapped meanwhile, nothing is deleted through the new path
 * and the temporary file stays where it was created.
 */
export function openOutputStream(out: OutputDir, name: string): {
  stream: fs.WriteStream;
  commit: () => Promise<void>;
  abort: () => void;
} {
  const target = outputFilePath(out, name);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let created: { dev: number; ino: number } | null = null;
  const removeTemp = (): void => {
    try {
      if (created === null) return;
      realDirectoryChain(out.projectRoot, out.relative.split('/'), 'output_dir', out.projectRoot, false);
      const stat = fs.lstatSync(temp);
      if (!stat.isFile() || stat.dev !== created.dev || stat.ino !== created.ino) return;
      fs.unlinkSync(temp);
    } catch { /* leave it in place */ }
  };
  let failure: unknown = null;
  let aborted = false;
  const stream = fs.createWriteStream(temp, { encoding: 'utf-8', flags: 'wx' });
  stream.on('open', fd => {
    try {
      const stat = fs.fstatSync(fd);
      created = { dev: stat.dev, ino: stat.ino };
    } catch { /* identity unknown: never delete */ }
    // Aborted before the file existed: remove it now that it does.
    if (aborted) removeTemp();
  });
  // Listen from the start: an error while the caller is still producing
  // bytes must neither go unhandled nor leave the temporary file behind.
  stream.on('error', error => {
    failure ??= error;
    removeTemp();
  });
  return {
    stream,
    commit: () => new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => {
        removeTemp();
        reject(error);
      };
      if (failure !== null) {
        fail(failure);
        return;
      }
      stream.once('error', fail);
      stream.once('finish', () => {
        stream.off('error', fail);
        try {
          const fd = fs.openSync(temp, 'r');
          try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          // Re-check the directory chain and the target just before replacing it.
          outputFilePath(out, name);
          commitStagedDurable(temp, target);
          resolve();
        } catch (error) {
          fail(error);
        }
      });
      stream.end();
    }),
    abort: () => {
      aborted = true;
      try { stream.destroy(); } catch { /* best effort */ }
      removeTemp();
    },
  };
}
