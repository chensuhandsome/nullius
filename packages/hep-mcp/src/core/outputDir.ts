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

// Device and inode as exact 64-bit integers: a JavaScript number cannot
// tell apart inode numbers above 2^53.
type FileIdentity = { dev: bigint; ino: bigint };

function identityOfDescriptor(fd: number): FileIdentity {
  const stat = fs.fstatSync(fd, { bigint: true });
  return { dev: stat.dev, ino: stat.ino };
}

type StagedFile = { name: string; temp: string; target: string; identity: FileIdentity };

/** A fresh, unpredictable staging name beside the target. */
function stagingPath(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
}

function isSameFile(filePath: string, identity: FileIdentity): boolean {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(filePath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  return stat.isFile() && stat.dev === identity.dev && stat.ino === identity.ino;
}

/**
 * Remove `file` (the staging file or the published file of output `name`),
 * but only while it is still the file with `identity`, reached through the
 * same real directories. If anything was swapped meanwhile, nothing is
 * deleted through the new path and the file stays where it was created.
 * Returns 'removed' when this call unlinked it, 'gone' when that name no
 * longer holds the file, and 'kept' when it could not be removed.
 */
function removeIfSame(out: OutputDir, name: string, file: string, identity: FileIdentity | null): 'removed' | 'gone' | 'kept' {
  if (identity === null) return lstatOrNull(file) === null ? 'gone' : 'kept';
  try {
    const chain = [...out.relative.split('/'), ...name.split('/').slice(0, -1)];
    realDirectoryChain(out.projectRoot, chain, 'output_dir', out.projectRoot, false);
    if (!isSameFile(file, identity)) return 'gone';
    fs.unlinkSync(file);
    return isSameFile(file, identity) ? 'kept' : 'removed';
  } catch {
    // Left in place; the caller decides whether that must be reported.
    return 'kept';
  }
}

function projectRelative(out: OutputDir, file: string): string {
  return toPosix(path.relative(out.projectRoot, file));
}

/** The message of the error a call failed with (or a plain note when none was given). */
function describeCause(cause: unknown): string {
  if (cause === undefined) return 'the call was discarded';
  return cause instanceof Error ? cause.message : String(cause);
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
  const message = describeCause(cause);
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
 * if any final name is taken, or anything else fails, the files this batch
 * had already published are removed, and so are its staging files. When
 * that cleanup succeeds, a call leaves either all of its files or none of
 * them. When it fails, the error says what is left (see `discard`):
 * published files make it UNSAFE_FS "outputs are incomplete" with
 * `files_left` (and `staging_left`); staging files alone keep the original
 * error, extended with `staging_left`; a staging file that could not be
 * identified is named in `staging_path`; removals that cannot be flushed to
 * disk give UNSAFE_FS with `unflushed_directories`. A call never changes a file that an earlier call wrote, so a
 * result cited elsewhere keeps its bytes. Directories created on the way
 * remain. Only a crash in the middle of `publish` can leave part of the set
 * without a report; a later call naming those files is refused rather than
 * mixed with them.
 *
 * `publish` is the call's commit point: a tool returns its result right
 * after it, with no further step that could fail.
 *
 * The directory chain from the project root is checked again before every
 * staging file is created and before every link; a staging or published
 * file is removed only while it is still the file this batch wrote (same
 * device and inode).
 */
export class OutputBatch {
  private readonly staged: StagedFile[] = [];
  private readonly claimed = new Set<string>();
  private readonly unfinished = new Set<() => void>();
  private readonly shared = new Map<string, Promise<unknown>>();
  // Staging files this batch created and has not yet removed, and published
  // files a rollback could not remove; the final report is built from what
  // is still here after the last cleanup attempt.
  private readonly stagingFiles = new Map<string, { name: string; identity: FileIdentity }>();
  private readonly publishedLeft = new Map<string, { name: string; identity: FileIdentity }>();
  // Directories from which this batch removed an entry; discard flushes
  // them, so a removal is not undone by a crash.
  private readonly cleanedDirectories = new Set<string>();
  private closed = false;
  private finalized = false;

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

  /** Remove `file` under the identity rule, recording its directory; true when it is gone. */
  private removeFile(name: string, file: string, identity: FileIdentity): boolean {
    const result = removeIfSame(this.out, name, file, identity);
    if (result === 'removed') this.cleanedDirectories.add(path.dirname(file));
    return result !== 'kept';
  }

  /** Remove a tracked staging file; true when it is gone. */
  private removeStaging(temp: string): boolean {
    const entry = this.stagingFiles.get(temp);
    if (entry === undefined) return true;
    if (!this.removeFile(entry.name, temp, entry.identity)) return false;
    this.stagingFiles.delete(temp);
    return true;
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
    if (key === nameKey(EXTERNAL_API_SUBDIR)) {
      throw invalidParams(`output file '${name}' would name the external_api/ record directory`, { artifact_name: name });
    }
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
      identity = identityOfDescriptor(fd);
      this.stagingFiles.set(temp, { name, identity });
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
      // If this removal fails the file stays tracked, and discard reports it.
      this.removeStaging(temp);
      throw failure;
    }
    this.staged.push({ name, temp, target, identity });
  }

  /**
   * An output file written piece by piece, staged like the others. The
   * staging file is created exclusively and identified before anything is
   * written, and every piece is written synchronously to that descriptor,
   * so a write error is thrown by `write` itself. `finish` flushes and
   * closes the file and stages it for publication. A failed write or finish
   * removes the staging file (a failed removal leaves it tracked, and
   * `discard` reports it); the file cannot be written or finished again.
   */
  openFile(name: string, mimeType: string): { write: (text: string) => void; finish: () => OutputArtifactRef } {
    const target = this.claim(name);
    const temp = stagingPath(target);
    const fd = fs.openSync(temp, 'wx');
    let identity: FileIdentity;
    try {
      identity = identityOfDescriptor(fd);
    } catch (error) {
      // Identity unknown: the file is closed but never deleted, and its path is reported.
      try { fs.closeSync(fd); } catch { /* the fstat failure is reported */ }
      throw unidentifiedStagingError(this.out, temp, error);
    }
    this.stagingFiles.set(temp, { name, identity });
    let open = true;
    const close = (): unknown => {
      if (!open) return null;
      open = false;
      try {
        fs.closeSync(fd);
        return null;
      } catch (error) {
        return error;
      }
    };
    const abort = (): void => {
      this.unfinished.delete(abort);
      close();
      this.removeStaging(temp);
    };
    this.unfinished.add(abort);
    const notOpen = (): Error => new Error('Internal: this output file was already finished or discarded');
    const write = (text: string): void => {
      if (!open) throw notOpen();
      try {
        const buffer = Buffer.from(text, 'utf-8');
        let offset = 0;
        while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
      } catch (error) {
        abort();
        throw error;
      }
    };
    const finish = (): OutputArtifactRef => {
      if (!open) throw notOpen();
      let failure: unknown = null;
      try {
        fs.fsyncSync(fd);
      } catch (error) {
        failure = error;
      }
      // Always close, keeping the first error.
      const closeFailure = close();
      failure ??= closeFailure;
      this.unfinished.delete(abort);
      if (failure !== null) {
        this.removeStaging(temp);
        throw failure;
      }
      this.staged.push({ name, temp, target, identity });
      return outputArtifactRef(this.out, name, mimeType);
    };
    return { write, finish };
  }

  /**
   * Link every staged file to its final name, never replacing an entry, and
   * remove the staging names. On any failure, remove what this batch
   * published and its staging files, and throw the final report (see
   * `discard`), built after that last cleanup attempt.
   */
  async publish(): Promise<void> {
    if (this.unfinished.size > 0) throw new Error('Internal: an output file of this call was not finished');
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
      const stagingLeft = this.staged.filter(file => !this.removeStaging(file.temp));
      if (stagingLeft.length > 0) {
        throw unsafeFs('staging files could not be removed after publishing', {
          project_root: this.out.projectRoot,
          staging_paths: stagingLeft.map(file => projectRelative(this.out, file.temp)),
        });
      }
      // Make the new entries durable: flush every directory from the
      // project root down to each published file, so directories created
      // on the way (output_dir itself, external_api/) are recorded in
      // their parents too. One flush per directory.
      const directories = new Set<string>();
      for (const file of this.staged) {
        for (let dir = path.dirname(file.target); ; dir = path.dirname(dir)) {
          directories.add(dir);
          if (dir === this.out.projectRoot || !isPathInside(this.out.projectRoot, dir)) break;
        }
      }
      for (const dir of directories) fsyncParentDirectoryDurable(path.join(dir, '.flush'));
    } catch (error) {
      for (const file of published) {
        if (!this.removeFile(file.name, file.target, file.identity)) {
          this.publishedLeft.set(file.target, { name: file.name, identity: file.identity });
        }
      }
      throw this.discard(error);
    }
  }

  /**
   * Drop everything this batch staged (nothing stays published) and return
   * the error to report for `cause`. This is the last cleanup attempt: it
   * retries every staging file and every published file still present, and
   * the report describes what is left after it.
   * The directories it removed entries from are then flushed, so a crash
   * cannot bring a removed file back.
   * - Published files left: UNSAFE_FS "outputs are incomplete", naming them
   *   (`files_left`), any staging files left, any directory whose flush
   *   failed, and the original error.
   * - A removal not known to be durable (a directory flush failed): UNSAFE_FS
   *   saying the cleanup may not survive a crash, naming those directories
   *   (`unflushed_directories`), any staging files left, and the original
   *   error.
   * - Only staging files left: the cause with its code kept, its message
   *   extended and the files named in `staging_left`.
   * - Nothing left: the cause itself.
   * A later call returns its cause unchanged: the report is already final.
   */
  discard(cause?: unknown): unknown {
    if (this.finalized) return cause;
    this.finalized = true;
    this.closed = true;
    for (const abort of [...this.unfinished]) abort();
    for (const temp of [...this.stagingFiles.keys()]) this.removeStaging(temp);
    for (const [target, entry] of [...this.publishedLeft]) {
      if (this.removeFile(entry.name, target, entry.identity)) this.publishedLeft.delete(target);
    }
    const unflushed: string[] = [];
    for (const dir of this.cleanedDirectories) {
      try {
        fsyncParentDirectoryDurable(path.join(dir, '.flush'));
      } catch {
        unflushed.push(projectRelative(this.out, dir) || '.');
      }
    }
    const stagingLeft = [...this.stagingFiles.keys()].map(temp => projectRelative(this.out, temp));
    const filesLeft = [...this.publishedLeft.keys()].map(target => projectRelative(this.out, target));
    const message = describeCause(cause);
    const original = { error: message, ...(cause instanceof McpError ? { error_code: cause.code } : {}) };
    if (filesLeft.length > 0) {
      return unsafeFs('publishing failed and some of its files could not be removed; this call\'s outputs are incomplete', {
        project_root: this.out.projectRoot,
        files_left: filesLeft,
        staging_left: stagingLeft,
        ...(unflushed.length > 0 ? { unflushed_directories: unflushed } : {}),
        ...original,
      });
    }
    if (unflushed.length > 0) {
      return unsafeFs('the call failed and its cleanup could not be flushed to disk; removed files may reappear after a crash', {
        project_root: this.out.projectRoot,
        unflushed_directories: unflushed,
        staging_left: stagingLeft,
        ...original,
      });
    }
    return withStagingLeft(this.out, cause, stagingLeft);
  }
}
