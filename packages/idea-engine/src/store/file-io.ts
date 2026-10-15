import { randomBytes } from 'crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import type { PathLike } from 'fs';
import { dirname } from 'path';
import { fileIdentityOfFd, unlinkIfSameFile } from '@nullius/shared';
import type { FileIdentity } from '@nullius/shared';

export function readJsonFile<T>(path: PathLike, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export function writeJsonFileAtomic(path: string, payload: unknown): void {
  writeStagedText(path, () => JSON.stringify(payload, null, 2));
}

export function writeTextFileAtomic(path: string, text: string): void {
  writeStagedText(path, () => text);
}

// `render` runs once the staging file exists, so a serialization failure is a
// failed write that removes it.
function writeStagedText(path: string, render: () => string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Fresh staging name beside the target, so the rename stays within one
  // directory and no entry left at a predictable name is reused.
  const tempPath = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  // 'wx' is O_CREAT|O_EXCL: the open fails on any existing entry at tempPath,
  // a symlink included (whatever it points to), so the bytes can only land in
  // a file created here.
  const fd = openSync(tempPath, 'wx');
  // Cleanup removes tempPath only while it still names the file created here
  // (same device and inode); an entry someone else put at that name stays.
  let staged: FileIdentity | undefined;
  const removeStaged = (): void => unlinkIfSameFile(tempPath, staged);

  try {
    staged = fileIdentityOfFd(fd);
    writeFileSync(fd, render(), 'utf8');
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* best-effort */ }
    removeStaged();
    throw error;
  }
  // A staging file that cannot be closed is not committed.
  try {
    closeSync(fd);
  } catch (error) {
    removeStaged();
    throw error;
  }

  // The rename is the commit. A staging file whose rename failed is removed;
  // once the rename has returned, the staging name is never touched again.
  try {
    renameSync(tempPath, path);
  } catch (error) {
    removeStaged();
    throw error;
  }
}

export function appendJsonLine(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, 'a+'); // a+ (not a): the heal below must READ the last byte

  try {
    // A crash mid-append can leave the file ending in a torn fragment with no
    // trailing newline. Appending directly would GLUE the new entry onto that
    // fragment, turning a recoverable torn line into a permanently
    // unparseable one. Heal instead: start a fresh line when the last byte is
    // not a newline (the torn fragment stays behind as its own bad line,
    // which log readers already skip).
    const size = statSync(path).size;
    let prefix = '';
    if (size > 0) {
      const lastByte = Buffer.alloc(1);
      readSync(fd, lastByte, 0, 1, size - 1);
      if (lastByte[0] !== 0x0a) {
        prefix = '\n';
      }
    }
    writeFileSync(fd, `${prefix}${JSON.stringify(payload)}\n`, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
