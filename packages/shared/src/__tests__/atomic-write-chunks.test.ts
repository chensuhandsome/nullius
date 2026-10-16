/**
 * writeChunksAtomicDurable: streamed content is staged at a fresh exclusive
 * name, committed by rename, and on any failure before the rename the staged
 * file — and only that file — is removed while the target stays as it was.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

import { randomBytes } from 'node:crypto';
import { _setAtomicWriteAuditHook, writeChunksAtomicDurable } from '../atomic-write.js';
import type { AtomicWriteAudit } from '../atomic-write.js';

const mockRandomBytes = vi.mocked(randomBytes);
const fixedHex = 'cd'.repeat(8);
const isWindows = process.platform === 'win32';

function plantFileAlias(target: string, alias: string): void {
  // Hardlinks exercise writes through an existing file name without requiring
  // Windows Developer Mode. POSIX retains its symbolic-link-specific coverage.
  if (isWindows) fs.linkSync(target, alias);
  else fs.symlinkSync(target, alias);
}

async function* chunksOf(...parts: Array<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) yield part;
}

describe('writeChunksAtomicDurable', () => {
  let dir: string;
  let outside: string;
  let file: string;
  let restoreHook: (() => void) | undefined;

  function hook(fn: AtomicWriteAudit): void {
    restoreHook = _setAtomicWriteAuditHook(fn);
  }
  function stagingEntries(): string[] {
    return fs.readdirSync(dir).filter(name => name.includes('.tmp.'));
  }

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-chunks-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-chunks-outside-')));
    file = path.join(dir, 'download.bin');
    mockRandomBytes.mockReset(); // back to the real randomBytes
  });

  afterEach(() => {
    restoreHook?.();
    restoreHook = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('streams every chunk into place and returns the identity of the committed file', async () => {
    fs.writeFileSync(file, 'old content');
    const events: string[] = [];
    hook(event => events.push(event.kind));

    const identity = await writeChunksAtomicDurable(file, chunksOf('ab', Buffer.from('cd'), 'ef'), 0o600);

    expect(fs.readFileSync(file, 'utf-8')).toBe('abcdef');
    expect(fs.statSync(file).mode & (isWindows ? 0o200 : 0o777)).toBe(isWindows ? 0o200 : 0o600);
    const committed = fs.lstatSync(file, { bigint: true });
    expect(identity).toEqual({ dev: committed.dev, ino: committed.ino });
    expect(stagingEntries()).toEqual([]);
    expect(events).toEqual([
      'mkdir', 'open', 'write', 'write', 'write', 'fchmod', 'fsync', 'close', 'rename',
      ...(isWindows ? [] : ['open', 'fsync', 'close']),
    ]);
  });

  it('replaces a link at the target instead of writing through it', async () => {
    const victim = path.join(outside, 'victim.bin');
    fs.writeFileSync(victim, 'ORIGINAL');
    plantFileAlias(victim, file);

    await writeChunksAtomicDurable(file, chunksOf('payload'));

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('payload');
  });

  it('refuses to stage through an entry already present at the fresh staging name', async () => {
    const victim = path.join(outside, 'victim.bin');
    fs.writeFileSync(victim, 'ORIGINAL');
    mockRandomBytes.mockImplementationOnce(() => Buffer.from(fixedHex, 'hex'));
    const staging = `${file}.tmp.${process.pid}.${fixedHex}`;
    plantFileAlias(victim, staging);
    let pulled = false;
    async function* source(): AsyncGenerator<string> {
      pulled = true;
      yield 'payload';
    }

    await expect(writeChunksAtomicDurable(file, source())).rejects.toThrow(/EEXIST/);

    expect(pulled).toBe(false);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    if (isWindows) expect(fs.statSync(staging, { bigint: true }).ino).toBe(fs.statSync(victim, { bigint: true }).ino);
    else expect(fs.readlinkSync(staging)).toBe(victim);
    expect(fs.existsSync(file)).toBe(false);
  });

  it.runIf(isWindows)('refuses a junction at the fresh staging name before consuming content', async () => {
    mockRandomBytes.mockImplementationOnce(() => Buffer.from(fixedHex, 'hex'));
    const staging = `${file}.tmp.${process.pid}.${fixedHex}`;
    fs.symlinkSync(outside, staging, 'junction');
    let pulled = false;
    async function* source(): AsyncGenerator<string> { pulled = true; yield 'payload'; }
    await expect(writeChunksAtomicDurable(file, source())).rejects.toThrow(/EEXIST/);
    expect(pulled).toBe(false);
    expect(fs.realpathSync(staging)).toBe(outside);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes its staging file and leaves the target as it was when the source fails midway', async () => {
    fs.writeFileSync(file, 'previous');
    async function* failing(): AsyncGenerator<string> {
      yield 'partial';
      throw new Error('upstream failed');
    }

    await expect(writeChunksAtomicDurable(file, failing())).rejects.toThrow('upstream failed');

    expect(fs.readFileSync(file, 'utf-8')).toBe('previous');
    expect(stagingEntries()).toEqual([]);
  });

  it('leaves an entry that replaced its staging file before the source failed', async () => {
    async function* failing(): AsyncGenerator<string> {
      yield 'partial';
      // The staging file is still open here, so its inode cannot be reused.
      const [name] = stagingEntries();
      fs.unlinkSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name), 'NOT OURS');
      throw new Error('upstream failed');
    }

    await expect(writeChunksAtomicDurable(file, failing())).rejects.toThrow('upstream failed');

    const staging = stagingEntries();
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, staging[0]), 'utf-8')).toBe('NOT OURS');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes its staging file when closing it fails', async () => {
    hook(event => {
      if (event.kind === 'close') throw new Error('injected close failure');
    });

    await expect(writeChunksAtomicDurable(file, chunksOf('payload'))).rejects.toThrow('injected close failure');

    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('removes its staging file when the final rename fails', async () => {
    fs.mkdirSync(path.join(file, 'inner'), { recursive: true });

    await expect(writeChunksAtomicDurable(file, chunksOf('payload'))).rejects.toThrow(/rename/);

    expect(fs.readdirSync(dir)).toEqual(['download.bin']);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('leaves whatever takes the vacated staging name after a completed rename', async () => {
    // The rename succeeds and the directory fsync then fails; the vacated
    // staging name by then holds a link to the very file that was staged.
    let staging: string | undefined;
    const failure = isWindows ? 'injected post-rename failure' : 'injected directory fsync failure';
    hook(event => {
      if (event.kind === 'rename') staging = event.from;
      const afterCommit = isWindows ? event.kind === 'rename'
        : event.kind === 'fsync' && fs.fstatSync(event.fd).isDirectory();
      if (staging !== undefined && afterCommit) {
        fs.linkSync(file, staging);
        throw new Error(failure);
      }
    });

    await expect(writeChunksAtomicDurable(file, chunksOf('payload'))).rejects.toThrow(failure);

    expect(stagingEntries()).toEqual([path.basename(staging!)]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('payload');
  });
});
