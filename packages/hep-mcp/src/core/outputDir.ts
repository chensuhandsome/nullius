import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fsyncParentDirectoryDurable, invalidParams, McpError, respellUnderDirectory, unsafeFs } from '@nullius/shared';

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

/**
 * How a file system may identify a name: Unicode-normalized and case-folded,
 * the conservative reading (the default macOS file systems ignore both).
 */
function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * Refuse a set of output file names in which two would name the same entry
 * (one file would silently replace the other while the result reported
 * both), or in which one would name the external_api/ subdirectory.
 */
export function assertDistinctOutputNames(names: Record<string, string>): void {
  const seen = new Map<string, string>([[nameKey(EXTERNAL_API_SUBDIR), 'the external_api/ record directory']]);
  for (const [role, name] of Object.entries(names)) {
    const key = nameKey(name);
    const other = seen.get(key);
    if (other !== undefined) {
      throw invalidParams(`output file names collide: ${role} '${name}' names the same entry as ${other}`, { names });
    }
    seen.set(key, role);
  }
}

export function outputArtifactRef(out: OutputDir, name: string, mimeType: string): OutputArtifactRef {
  return { name, path: `${out.relative}/${name}`, mimeType };
}

type FileIdentity = { dev: number; ino: number };

type StagedFile = { name: string; temp: string; target: string; identity: FileIdentity };

/** A fresh, unpredictable staging name beside the target. */
function stagingPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
}

function isSameFile(filePath: string, identity: FileIdentity): boolean {
  const stat = lstatOrNull(filePath);
  return stat !== null && stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino;
}

/**
 * Remove `file` (the staging file or the published file of output `name`),
 * but only while it is still the file with `identity`, reached through the
 * same real directories. If anything was swapped meanwhile, nothing is
 * deleted through the new path and the file stays where it was created.
 */
function removeIfSame(out: OutputDir, name: string, file: string, identity: FileIdentity | null): boolean {
  if (identity === null) return lstatOrNull(file) === null;
  try {
    const chain = [...out.relative.split('/'), ...name.split('/').slice(0, -1)];
    realDirectoryChain(out.projectRoot, chain, 'output_dir', out.projectRoot, false);
    if (isSameFile(file, identity)) fs.unlinkSync(file);
    return !isSameFile(file, identity);
  } catch {
    // Left in place; the caller decides whether that must be reported.
    return false;
  }
}

function projectRelative(out: OutputDir, file: string): string {
  return toPosix(path.relative(out.projectRoot, file));
}

/**
 * The error to report for `cause` when some staging files could not be
 * removed: the cause itself if none were left, otherwise the cause (same
 * code, message extended) with the files named in `staging_left`.
 */
function withStagingLeft(out: OutputDir, cause: unknown, left: string[]): unknown {
  if (left.length === 0) return cause;
  const note = `; staging files could not be removed: ${left.join(', ')}`;
  if (cause instanceof McpError) {
    const data = cause.data && typeof cause.data === 'object' && !Array.isArray(cause.data)
      ? cause.data as Record<string, unknown>
      : { cause_data: cause.data };
    return new McpError(cause.code, `${cause.message}${note}`, { ...data, staging_left: left });
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return unsafeFs(`${message}${note}`, { project_root: out.projectRoot, error: message, staging_left: left });
}

/** The error for a staging file created but not identified; it stays where it is. */
function unidentifiedStagingError(out: OutputDir, temp: string, error: unknown): Error {
  return unsafeFs('a new staging file could not be identified and was left in place', {
    project_root: out.projectRoot,
    staging_path: projectRelative(out, temp),
    error: error instanceof Error ? error.message : String(error),
  });
}

function existingOutputError(out: OutputDir, name: string): Error {
  return invalidParams(
    `output file '${name}' already exists in output_dir; a call never replaces earlier outputs: choose another output_dir or artifact name, or remove the earlier file`,
    { project_root: out.projectRoot, output_dir: out.relative, artifact_name: name },
  );
}

/**
 * The files one tool call writes into its output directory.
 *
 * Each file is first written in full to its own staging file beside its
 * final name (created exclusively under an unpredictable name, so an
 * existing entry, symlink or not, is never opened or followed) and flushed
 * to disk; no final name appears before `publish`. `publish` then links
 * every staged file to its final name, never replacing an existing entry:
 * if any final name is taken, the call fails and the files this batch had
 * already published are removed. A call therefore leaves either all of its
 * files or none of them, and never changes a file that an earlier call
 * wrote, so a result cited elsewhere keeps its bytes. Directories created
 * on the way remain. A crash in the middle of `publish` can leave part of
 * the set; a later call naming those files is then refused rather than
 * mixed with them.
 *
 * The directory chain from the project root is checked again before every
 * staging file is created and before every link; a staging or published
 * file is removed only while it is still the file this batch wrote (same
 * device and inode).
 */
export class OutputBatch {
  private readonly staged: StagedFile[] = [];
  private readonly claimed = new Set<string>();
  private readonly unfinished = new Set<() => string | null>();
  private readonly shared = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(readonly out: OutputDir) {}

  /**
   * Check, before any provider work, that the names this call will write
   * are mutually distinct (as a file system may compare them) and not yet
   * taken in the output directory.
   */
  reserve(names: Record<string, string>): void {
    assertDistinctOutputNames(names);
    for (const name of Object.values(names)) {
      if (lstatOrNull(outputFilePath(this.out, name)) !== null) throw existingOutputError(this.out, name);
    }
  }

  /** Whether this batch already holds output `name`. */
  has(name: string): boolean {
    return this.claimed.has(nameKey(name));
  }

  /**
   * Refuse, before provider work, an output name that is taken in the
   * output directory (a name this batch already holds is fine).
   */
  assertFree(name: string): void {
    if (this.has(name)) return;
    if (lstatOrNull(outputFilePath(this.out, name)) !== null) throw existingOutputError(this.out, name);
  }

  /**
   * Run `work` once per key within this call; later callers with the same
   * key, concurrent or not, share its result or its failure.
   */
  once<T>(key: string, work: () => Promise<T>): Promise<T> {
    let pending = this.shared.get(key) as Promise<T> | undefined;
    if (pending === undefined) {
      pending = work();
      this.shared.set(key, pending);
    }
    return pending;
  }

  json(name: string, data: unknown): OutputArtifactRef {
    // Serialize first, so no time-consuming step separates the check from the write.
    this.stageBytes(name, JSON.stringify(data, null, 2));
    return outputArtifactRef(this.out, name, 'application/json');
  }

  jsonl(name: string, rows: unknown[]): OutputArtifactRef {
    const body = rows.map(row => JSON.stringify(row)).join('\n');
    this.stageBytes(name, rows.length > 0 ? `${body}\n` : '');
    return outputArtifactRef(this.out, name, 'application/x-ndjson');
  }

  private claim(name: string): string {
    if (this.closed) throw new Error('Internal: this output batch was already published or discarded');
    const key = nameKey(name);
    if (this.claimed.has(key)) {
      throw invalidParams(`two outputs of this call name the same file '${name}'`, { artifact_name: name });
    }
    const target = outputFilePath(this.out, name);
    if (lstatOrNull(target) !== null) throw existingOutputError(this.out, name);
    this.claimed.add(key);
    return target;
  }

  private stageBytes(name: string, bytes: string): void {
    const target = this.claim(name);
    const temp = stagingPath(target);
    const fd = fs.openSync(temp, 'wx');
    let identity: FileIdentity | null = null;
    let failure: unknown = null;
    try {
      const stat = fs.fstatSync(fd);
      identity = { dev: stat.dev, ino: stat.ino };
      const buffer = Buffer.from(bytes, 'utf-8');
      let offset = 0;
      while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
      fs.fsyncSync(fd);
    } catch (error) {
      failure = error;
    }
    try {
      fs.closeSync(fd);
    } catch (error) {
      failure ??= error;
    }
    if (identity === null) throw unidentifiedStagingError(this.out, temp, failure);
    if (failure !== null) {
      removeIfSame(this.out, name, temp, identity);
      throw failure;
    }
    this.staged.push({ name, temp, target, identity });
  }

  /**
   * A streamed output file, staged like the others. The staging file is
   * created (exclusively) and identified before the stream exists, so it can
   * be removed at any moment, whatever the stream is doing. A stream error
   * while writing or finishing is held until `finish`, which then rejects
   * with it; on every failure path the staging file is removed under the
   * identity rule.
   */
  stream(name: string, mimeType: string): { stream: fs.WriteStream; finish: () => Promise<OutputArtifactRef> } {
    const target = this.claim(name);
    const temp = stagingPath(target);
    const fd = fs.openSync(temp, 'wx');
    let created: FileIdentity;
    try {
      const stat = fs.fstatSync(fd);
      created = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      // Identity unknown: the file is closed but never deleted, and its path is reported.
      try { fs.closeSync(fd); } catch { /* the fstat failure is reported */ }
      throw unidentifiedStagingError(this.out, temp, error);
    }
    let failure: unknown = null;
    let aborted = false;
    const removeTemp = (): boolean => removeIfSame(this.out, name, temp, created);
    const stream = fs.createWriteStream(temp, { fd, encoding: 'utf-8' });
    // Returns the staging file's project-relative path if it could not be removed.
    const abort = (): string | null => {
      aborted = true;
      this.unfinished.delete(abort);
      try { stream.destroy(); } catch { /* best effort */ }
      return removeTemp() ? null : projectRelative(this.out, temp);
    };
    this.unfinished.add(abort);
    // Listen from the start: an error while the caller is still producing
    // bytes must neither go unhandled nor leave the staging file behind.
    stream.on('error', error => {
      failure ??= error;
      removeTemp();
    });
    const finish = (): Promise<OutputArtifactRef> => new Promise<OutputArtifactRef>((resolve, reject) => {
      const fail = (error: unknown): void => {
        this.unfinished.delete(abort);
        removeTemp();
        reject(error);
      };
      if (failure !== null) {
        fail(failure);
        return;
      }
      // A discarded stream never finishes; say so instead of waiting forever.
      if (aborted) {
        fail(new Error('Internal: this output stream was discarded before it finished'));
        return;
      }
      // A stream destroyed by an error reports that error once it has closed.
      if (stream.destroyed) {
        const settle = (): void => fail(failure ?? new Error('Internal: this output stream closed before it finished'));
        if (stream.closed) settle();
        else stream.once('close', settle);
        return;
      }
      stream.once('error', fail);
      stream.once('finish', () => {
        stream.off('error', fail);
        let flushFailure: unknown = null;
        try {
          // Flush the file this stream wrote (checked by identity).
          const readFd = fs.openSync(temp, 'r');
          try {
            const stat = fs.fstatSync(readFd);
            if (stat.dev !== created.dev || stat.ino !== created.ino) {
              throw unsafeFs('staged output file was replaced or is unknown; refusing to keep it', {
                project_root: this.out.projectRoot,
                path: temp,
              });
            }
            fs.fsyncSync(readFd);
          } catch (error) {
            flushFailure = error;
          }
          try {
            fs.closeSync(readFd);
          } catch (error) {
            flushFailure ??= error;
          }
        } catch (error) {
          flushFailure ??= error;
        }
        if (flushFailure !== null) {
          fail(flushFailure);
          return;
        }
        this.unfinished.delete(abort);
        this.staged.push({ name, temp, target, identity: created });
        resolve(outputArtifactRef(this.out, name, mimeType));
      });
      stream.end();
    });
    return { stream, finish };
  }

  /**
   * Link every staged file to its final name, never replacing an entry, and
   * remove the staging names; on any failure remove what this batch
   * published. If a published file cannot be removed, the error says so and
   * names it, since the call's files are then not all-or-none.
   */
  async publish(): Promise<void> {
    if (this.unfinished.size > 0) throw new Error('Internal: an output stream of this call was not finished');
    if (this.closed) throw new Error('Internal: this output batch was already published or discarded');
    this.closed = true;
    const published: StagedFile[] = [];
    try {
      for (const file of this.staged) {
        outputFilePath(this.out, file.name);
        if (lstatOrNull(file.target) !== null) throw existingOutputError(this.out, file.name);
        if (!isSameFile(file.temp, file.identity)) {
          throw unsafeFs('staged output file was replaced; refusing to publish it', {
            project_root: this.out.projectRoot,
            path: file.temp,
          });
        }
        try {
          fs.linkSync(file.temp, file.target);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') throw existingOutputError(this.out, file.name);
          if (code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS') {
            throw unsafeFs('output_dir is on a file system without hard links, which publishing outputs without replacing files needs', {
              project_root: this.out.projectRoot,
              output_dir: this.out.relative,
              error: (error as Error).message,
            });
          }
          throw error;
        }
        published.push(file);
      }
      // A published call leaves no staging name behind.
      const stagingLeft = this.staged.filter(file => !removeIfSame(this.out, file.name, file.temp, file.identity));
      if (stagingLeft.length > 0) {
        throw unsafeFs('staging files could not be removed after publishing', {
          project_root: this.out.projectRoot,
          staging_paths: stagingLeft.map(file => projectRelative(this.out, file.temp)),
        });
      }
      // Make the new directory entries durable: one flush per directory.
      const oneFilePerDirectory = new Map(this.staged.map(file => [path.dirname(file.target), file.target]));
      for (const target of oneFilePerDirectory.values()) fsyncParentDirectoryDurable(target);
    } catch (error) {
      const publishedLeft = published.filter(file => !removeIfSame(this.out, file.name, file.target, file.identity));
      const stagingLeft = this.removeStagedFiles();
      if (publishedLeft.length > 0) {
        throw unsafeFs('publishing failed and some of its files could not be removed; this call\'s outputs are incomplete', {
          project_root: this.out.projectRoot,
          files_left: publishedLeft.map(file => projectRelative(this.out, file.target)),
          staging_left: stagingLeft,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw withStagingLeft(this.out, error, stagingLeft);
    }
  }

  /**
   * Drop everything this batch staged; nothing is published. Returns the
   * error to report for `cause`: the cause itself, or, when some staging
   * file could not be removed, the cause with those files named.
   */
  discard(cause?: unknown): unknown {
    this.closed = true;
    const left: string[] = [];
    for (const abort of [...this.unfinished]) {
      const kept = abort();
      if (kept !== null) left.push(kept);
    }
    left.push(...this.removeStagedFiles());
    return withStagingLeft(this.out, cause, left);
  }

  /** Remove the staging files; returns those that could not be removed. */
  private removeStagedFiles(): string[] {
    return this.staged
      .filter(file => !removeIfSame(this.out, file.name, file.temp, file.identity))
      .map(file => projectRelative(this.out, file.temp));
  }
}
