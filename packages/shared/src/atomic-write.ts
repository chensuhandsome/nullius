/**
 * Durable atomic file writes (P1).
 *
 * Provides seven primitives that guarantee POSIX-correct durability against
 * crash / power-loss between syscalls — the gold-standard pattern already
 * proven in `packages/orchestrator/src/run-manifest.ts:82-97` (Batch 8 R2
 * fix). Lifted into `@nullius/shared` so every package that writes
 * artifacts can converge on one byte-accurate, sequence-verified
 * implementation rather than the half-fsync'd helpers that previously
 * lived in `orchestrator/computation/io.ts` and
 * `hep-mcp/core/atomicWrite.ts`.
 *
 * ## The sequence (matches `run-manifest.ts:82-97`)
 *
 *   1. mkdirSync(dirname, recursive)
 *   2. fd = openSync(tmp, 'wx', mode ?? 0o644)   // fresh name, exclusive create
 *   3. writeFileSync(fd, bytes)          // full-write guarantee via fd path
 *   4. fchmodSync(fd, mode) if mode supplied   // close the umask-clip gap
 *   5. fsyncSync(fd)                     // file contents to disk
 *   6. closeSync(fd)
 *   7. renameSync(tmp, final)            // atomic rename
 *   8. dirFd = openSync(dirname, 'r')
 *   9. fsyncSync(dirFd)                  // directory entry persisted
 *   10. closeSync(dirFd)
 *
 * On any error before the rename: the partial tmp file is unlinked
 * best-effort, and only while the tmp name still holds the file created in
 * step 2. The unlink is intentionally best-effort because the caller has
 * bigger problems if it fires (the throw propagates up). Once the rename has
 * returned, the tmp name is never touched again.
 *
 * ## Why ALL seven primitives?
 *
 * - {@link writeBytesAtomicDurable}: the generic byte / string write. Used
 *   for binary artifacts, executable scripts, text rollback restores.
 * - {@link writeChunksAtomicDurable}: the same staging and commit for content
 *   that arrives as a stream of chunks (a download, a decompression).
 * - {@link writeJsonAtomicDurable}: typed wrapper that handles JSON
 *   stringification. The default stringify is non-sorting; callers needing
 *   Python-`sort_keys=True` byte-equality pass `sortKeysRecursive`
 *   themselves via the `stringify` argument.
 * - {@link appendJsonlDurable}: append-only with file+dir fsync. Designed
 *   for ledgers and other append-only logs where each append must survive
 *   crash before the next syscall.
 * - {@link appendBytesDurable}: the raw-bytes form of the same append for
 *   in-place boundary repairs (e.g. a missing trailing newline) that must
 *   not replace the inode.
 * - {@link writeExecutableAtomicDurable}: mode-at-create wrapper for
 *   executable scripts. Closes the chmod-after-write race that allowed
 *   another process to exec a half-written launcher.
 * - {@link commitStagedDurable}: rename-only commit for callers that have
 *   already written and fsync'd the staged file themselves and only need
 *   the rename to be persisted to the directory entry.
 * - {@link fsyncParentDirectoryDurable}: explicit directory-entry durability
 *   confirmation for recovery after a caller observed a post-rename error.
 * - {@link fileIdentityOfFd} / {@link unlinkIfSameFile}: exact (bigint) file
 *   identity and identity-checked removal, for callers that stage their own
 *   file with an exclusive create and must clean it up without removing an
 *   entry someone else put at that name.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Instrumentation hook used by tests to lock the EXACT syscall sequence
 * of each primitive (mkdir → open → write → fsync(fd) → close → rename →
 * open(dir,r) → fsync(dirFd) → close). Production code never sets this.
 *
 * The audit hook is opt-in and fires AFTER each operation completes — it
 * cannot alter behavior, only record. Sequence-locking tests register a
 * recorder, run a primitive, then assert the recorded event list matches
 * the expected order.
 *
 * `vi.spyOn(fs, ...)` doesn't work reliably on Node's ESM `node:fs`
 * namespace export in vitest, hence this explicit instrumentation point.
 */
export type AtomicWriteAuditEvent =
  | { kind: 'mkdir'; path: string }
  | { kind: 'open'; path: string; flags: string; mode?: number; fd: number }
  | { kind: 'write'; fd: number; bytes: number }
  | { kind: 'fchmod'; fd: number; mode: number }
  | { kind: 'fsync'; fd: number }
  | { kind: 'close'; fd: number }
  | { kind: 'rename'; from: string; to: string };

export type AtomicWriteAudit = (event: AtomicWriteAuditEvent) => void;

let _audit: AtomicWriteAudit | undefined;

/**
 * Test-only: install an audit hook that records every fs syscall the
 * primitives make. Returns a `restore` callback that removes the hook.
 * Calling this from production code is a contract violation.
 */
export function _setAtomicWriteAuditHook(hook: AtomicWriteAudit | undefined): () => void {
  const prev = _audit;
  _audit = hook;
  return () => { _audit = prev; };
}

function audit(event: AtomicWriteAuditEvent): void {
  if (_audit) _audit(event);
}

/**
 * Generate a fresh tmp-file path adjacent to the final path: the process PID
 * plus 64 random bits, so no other writer shares the slot and no entry can be
 * planted at the name in advance.
 *
 * The tmp file lives in the SAME directory as the final path so the
 * subsequent `renameSync` is guaranteed-atomic (POSIX same-fs).
 */
function makeTmpPath(filePath: string): string {
  return `${filePath}.tmp.${process.pid}.${randomBytes(8).toString('hex')}`;
}

/**
 * Exact identity of a file: its device and inode numbers, read as bigint so
 * that inode numbers above 2^53 are compared without rounding.
 */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/** Identity of the file open at `fd`. */
export function fileIdentityOfFd(fd: number): FileIdentity {
  const { dev, ino } = fs.fstatSync(fd, { bigint: true });
  return { dev, ino };
}

/**
 * Best-effort removal of a staged file: unlinks `filePath` only while that
 * name (not following a symlink) still holds the file with `identity`, so an
 * entry someone else put at that name stays. Errors are swallowed; with no
 * identity recorded nothing is removed.
 */
export function unlinkIfSameFile(filePath: string, identity: FileIdentity | undefined): void {
  if (!identity) return;
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(filePath);
  } catch { /* best-effort */ }
}

/**
 * fsync the parent directory of `filePath`. Required after `renameSync`
 * to guarantee the new directory entry survives a crash on POSIX
 * filesystems (ext4/xfs/btrfs/APFS).
 *
 * Opens with `'r'` because directory-fsync only needs read access on
 * Linux/macOS; `'w'` would fail with EISDIR on most systems.
 *
 * **Windows note**: opening a directory + `FlushFileBuffers` is
 * undefined on NTFS and returns ERROR_ACCESS_DENIED. This codebase
 * targets macOS + Linux (the nullius project's CI matrix), and
 * Node.js itself documents `fsync` on a directory fd as
 * platform-dependent. If a Windows port is ever added, gate this on
 * `process.platform`.
 */
export function fsyncParentDirectoryDurable(filePath: string): void {
  const dir = path.dirname(filePath);
  const dirFd = fs.openSync(dir, 'r');
  audit({ kind: 'open', path: dir, flags: 'r', fd: dirFd });
  try {
    fs.fsyncSync(dirFd);
    audit({ kind: 'fsync', fd: dirFd });
  } finally {
    fs.closeSync(dirFd);
    audit({ kind: 'close', fd: dirFd });
  }
}

/**
 * Primitive 1: durable atomic byte/string write.
 *
 * Writes `bytes` to `filePath` with full POSIX durability:
 * write tmp → fsync(fd) → rename → fsync(dirFd). Caller-supplied `mode`
 * is set at file create AND enforced via `fchmodSync` before fsync
 * (defends against umask clipping AND closes the post-rename chmod race
 * that would let another process exec a partial file with the wrong mode).
 *
 * The tmp file is created exclusively ('wx' is O_CREAT|O_EXCL): the open
 * fails on any existing entry at the tmp name, a symlink included, so the
 * bytes can only land in a file created here. On error before the rename, the
 * tmp file is unlinked best-effort while the tmp name still holds that file.
 *
 * `beforeRename`, when supplied, runs after the staged bytes have been
 * flushed and the temporary fd has closed, at the last userspace point before
 * the atomic rename. A throwing guard leaves the destination untouched and
 * removes the staged file best-effort. It is intended for callers that must
 * revalidate an optimistic read immediately before commit; it cannot turn a
 * non-cooperating filesystem writer into a portable compare-and-swap.
 *
 * @example
 * writeBytesAtomicDurable('/p/state.json', Buffer.from(json), 0o600);
 */
export function writeBytesAtomicDurable(
  filePath: string,
  bytes: Buffer | string,
  mode?: number,
  beforeRename?: () => void,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  audit({ kind: 'mkdir', path: dir });
  const tmpPath = makeTmpPath(filePath);
  const flags = 'wx';
  // Pass mode to openSync so the file is created with the target mode
  // bits AT CREATE TIME, eliminating the window where another process
  // could observe a more-permissive file before chmod.
  const fd = mode !== undefined
    ? fs.openSync(tmpPath, flags, mode)
    : fs.openSync(tmpPath, flags);
  audit({ kind: 'open', path: tmpPath, flags, mode, fd });
  // Cleanup removes tmpPath only while it still names the file created here
  // (same device and inode); an entry someone else put at that name stays.
  let staged: FileIdentity | undefined;
  const removeStaged = (): void => unlinkIfSameFile(tmpPath, staged);
  const byteLen = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.length;
  try {
    staged = fileIdentityOfFd(fd);
    fs.writeFileSync(fd, bytes);
    audit({ kind: 'write', fd, bytes: byteLen });
    if (mode !== undefined) {
      // Belt-and-suspenders: even though openSync(mode) sets bits at
      // create, umask may clip them. fchmodSync forces the exact mode.
      fs.fchmodSync(fd, mode);
      audit({ kind: 'fchmod', fd, mode });
    }
    fs.fsyncSync(fd);
    audit({ kind: 'fsync', fd });
  } catch (err) {
    try { fs.closeSync(fd); audit({ kind: 'close', fd }); } catch { /* best-effort */ }
    removeStaged();
    throw err;
  }
  try {
    fs.closeSync(fd);
    audit({ kind: 'close', fd });
  } catch (closeErr) {
    // Extremely rare (EIO on flush-during-close). Best-effort cleanup of
    // the tmp file so it doesn't accumulate on disk, then surface the
    // original error.
    removeStaged();
    throw closeErr;
  }
  if (beforeRename) {
    try {
      beforeRename();
    } catch (guardError) {
      removeStaged();
      throw guardError;
    }
  }
  // A tmp file whose rename failed is removed; once the rename has returned,
  // the tmp name is never touched again, whatever the audit hook or the
  // directory fsync does.
  commitStagedDurable(tmpPath, filePath, removeStaged);
}

/**
 * Primitive 1b: durable atomic streamed write.
 *
 * The same staging and commit as {@link writeBytesAtomicDurable}, for content
 * that arrives as a sequence of chunks (a download, a decompression): each
 * chunk is written to the exclusively created tmp file as it arrives, then the
 * file is fsync'd, closed and renamed into place, and the parent directory is
 * fsync'd. If iterating `chunks` throws (an upstream stream error) or any step
 * before the rename fails, the tmp file is removed while the tmp name still
 * holds the file created here, the error propagates, and `filePath` is left as
 * it was.
 *
 * Returns the identity of the committed file, so a caller that later removes
 * it can do so with {@link unlinkIfSameFile}.
 *
 * @example
 * await pipeline(response, gunzip, (source) => writeChunksAtomicDurable(out, source));
 */
export async function writeChunksAtomicDurable(
  filePath: string,
  chunks: AsyncIterable<Uint8Array | string>,
  mode?: number,
): Promise<FileIdentity> {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  audit({ kind: 'mkdir', path: dir });
  const tmpPath = makeTmpPath(filePath);
  const flags = 'wx';
  const fd = mode !== undefined
    ? fs.openSync(tmpPath, flags, mode)
    : fs.openSync(tmpPath, flags);
  audit({ kind: 'open', path: tmpPath, flags, mode, fd });
  // Cleanup removes tmpPath only while it still names the file created here
  // (same device and inode); an entry someone else put at that name stays.
  let staged: FileIdentity | undefined;
  const removeStaged = (): void => unlinkIfSameFile(tmpPath, staged);
  try {
    staged = fileIdentityOfFd(fd);
    for await (const chunk of chunks) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      // Each call writes the whole chunk at the current file position.
      fs.writeFileSync(fd, bytes);
      audit({ kind: 'write', fd, bytes: bytes.byteLength });
    }
    if (mode !== undefined) {
      fs.fchmodSync(fd, mode);
      audit({ kind: 'fchmod', fd, mode });
    }
    fs.fsyncSync(fd);
    audit({ kind: 'fsync', fd });
  } catch (err) {
    try { fs.closeSync(fd); audit({ kind: 'close', fd }); } catch { /* best-effort */ }
    removeStaged();
    throw err;
  }
  try {
    fs.closeSync(fd);
    audit({ kind: 'close', fd });
  } catch (closeErr) {
    removeStaged();
    throw closeErr;
  }
  commitStagedDurable(tmpPath, filePath, removeStaged);
  // Set before any byte was written; the commit kept the same file.
  return staged as FileIdentity;
}

/**
 * Primitive 2: durable atomic JSON write.
 *
 * Wraps {@link writeBytesAtomicDurable} with JSON stringification. The
 * default stringify emits `JSON.stringify(payload, null, 2) + '\n'`
 * (pretty-printed, trailing newline). Callers that need a stable
 * sort-keys representation (e.g. Python parity) pass their own
 * `stringify` such as:
 *
 *     writeJsonAtomicDurable(
 *       path,
 *       payload,
 *       p => JSON.stringify(sortKeysRecursive(p), null, 2) + '\n',
 *     )
 *
 * `sortKeysRecursive` is exported from `@nullius/shared/utils`.
 */
export function writeJsonAtomicDurable(
  filePath: string,
  payload: unknown,
  stringify?: (payload: unknown) => string,
): void {
  const content = stringify
    ? stringify(payload)
    : JSON.stringify(payload, null, 2) + '\n';
  writeBytesAtomicDurable(filePath, content);
}

/**
 * Primitive 3: durable JSON-Lines append.
 *
 * Appends one line (JSON-stringified, then `\n`) to `filePath`. Each
 * append is durable: write → fsync(fd) → close → fsync(dirFd). Designed
 * for ledgers and other append-only logs that must survive crash
 * between syscalls.
 *
 * Unlike the write primitives, this never uses a tmp+rename — append is
 * inherently in-place. The directory fsync is still required because a
 * newly-created file's directory entry must be persisted (and is cheap
 * for already-existing files).
 *
 * @example
 * appendJsonlDurable('/p/ledger.jsonl', { ts: now, event: 'created' });
 */
export function appendJsonlDurable(
  filePath: string,
  lineObject: unknown,
): void {
  appendBytesDurable(filePath, JSON.stringify(lineObject) + '\n');
}

/**
 * Primitive 3b: durable raw append.
 *
 * Same durability contract as {@link appendJsonlDurable} (in-place
 * O_APPEND write, file fsync, close, parent-dir fsync) for callers that
 * must append bytes that are not one JSON line — e.g. repairing a
 * missing trailing newline on an append-only ledger without replacing
 * the inode (which would reset ownership/mode and break read-only
 * intent).
 */
export function appendBytesDurable(
  filePath: string,
  bytes: string | Uint8Array,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  audit({ kind: 'mkdir', path: dir });
  const fd = fs.openSync(filePath, 'a');
  audit({ kind: 'open', path: filePath, flags: 'a', fd });
  try {
    fs.writeFileSync(fd, bytes);
    audit({ kind: 'write', fd, bytes: typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength });
    fs.fsyncSync(fd);
    audit({ kind: 'fsync', fd });
  } catch (err) {
    try { fs.closeSync(fd); audit({ kind: 'close', fd }); } catch { /* best-effort */ }
    throw err;
  }
  fs.closeSync(fd);
  audit({ kind: 'close', fd });
  fsyncParentDirectoryDurable(filePath);
}

/**
 * Primitive 4: durable atomic executable-script write.
 *
 * Convenience wrapper over {@link writeBytesAtomicDurable} with
 * `mode = 0o700` enforced at create. Used for project-local launcher
 * scripts and similar; closes the chmod-after-write race that allowed
 * a peer process to `exec` a partial file with wrong mode bits.
 *
 * `0o700` (owner read/write/execute, no group/other) is the safe default
 * — these scripts are user-local and have no scenario requiring
 * other-execute access. Override only if a documented multi-user case
 * justifies it.
 */
export function writeExecutableAtomicDurable(
  filePath: string,
  script: string,
): void {
  writeBytesAtomicDurable(filePath, script, 0o700);
}

/**
 * Primitive 5: durable commit of a previously-written staged file.
 *
 * Used when the caller has already written `stagedPath` durably (via
 * one of the write primitives above) and only needs to rename it to
 * `finalPath` with parent-dir fsync. This separates "write the staged
 * file" from "commit the rename" so callers can interleave additional
 * work (e.g. append a ledger event for the state change) BETWEEN the
 * staged write and the final commit while preserving durability of each.
 *
 * Precondition (caller contract): `stagedPath` must already exist on
 * disk, must be fsync'd, and must share the same parent directory as
 * `finalPath` (so the rename is same-fs and atomic).
 *
 * Runtime guard: throws if `dirname(stagedPath) !== dirname(finalPath)`.
 *
 * `onRenameFailed`, when supplied, runs when the commit throws before the
 * rename has taken place (the guard above refused, or `renameSync` threw),
 * and then the error propagates. It never runs once `renameSync` has
 * returned, so a caller can use it to remove its staged file without ever
 * touching the vacated staged name after a completed rename — whatever a
 * later step (the directory fsync) does.
 *
 * @example
 * writeJsonAtomicDurable(stagedPath, state);  // staged write
 * appendJsonlDurable(ledgerPath, event);       // ledger event
 * commitStagedDurable(stagedPath, finalPath); // commit the rename
 */
export function commitStagedDurable(
  stagedPath: string,
  finalPath: string,
  onRenameFailed?: () => void,
): void {
  try {
    const stagedDir = path.dirname(stagedPath);
    const finalDir = path.dirname(finalPath);
    if (stagedDir !== finalDir) {
      throw new Error(
        `commitStagedDurable: stagedPath and finalPath must share the same parent directory; staged=${stagedDir} final=${finalDir}`,
      );
    }
    fs.renameSync(stagedPath, finalPath);
  } catch (err) {
    onRenameFailed?.();
    throw err;
  }
  audit({ kind: 'rename', from: stagedPath, to: finalPath });
  fsyncParentDirectoryDurable(finalPath);
}

/**
 * Durably MOVE an existing directory entry (file or directory tree) to a
 * destination under a DIFFERENT parent — the cross-parent counterpart of
 * `commitStagedDurable`. Both parent directories are fsync'd: the entry's
 * disappearance from the source directory and its appearance in the
 * destination directory are separate dirent updates, and a crash between
 * them must not leave a recorded state (e.g. a ledger event naming an
 * archive location) pointing at an entry whose move never became durable.
 *
 * Same-filesystem only (rename semantics); an EXDEV crossing throws to the
 * caller, which owns the fallback policy. The destination must not exist —
 * rename would otherwise clobber it on POSIX for files (and fail
 * confusingly for directories), so existence is the caller's check.
 */
export function moveEntryDurable(fromPath: string, toPath: string): void {
  fs.renameSync(fromPath, toPath);
  audit({ kind: 'rename', from: fromPath, to: toPath });
  fsyncParentDirectoryDurable(toPath);
  fsyncParentDirectoryDurable(fromPath);
}
