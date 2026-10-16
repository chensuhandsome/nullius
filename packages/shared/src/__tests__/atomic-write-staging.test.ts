/**
 * Staging-file safety of writeBytesAtomicDurable: the tmp file is created at
 * a fresh name that cannot be planted in advance, the create refuses any
 * existing entry (a symlink included), cleanup removes only the file this
 * call created, and nothing touches the tmp name once the rename returned.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), lstatSync: vi.fn(actual.lstatSync) };
});

import { randomBytes } from 'node:crypto';
import {
  _setAtomicWriteAuditHook,
  commitStagedDurable,
  fileIdentityOfFd,
  unlinkIfSameFile,
  writeBytesAtomicDurable,
} from '../atomic-write.js';
import type { AtomicWriteAudit } from '../atomic-write.js';

const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const mockRandomBytes = vi.mocked(randomBytes);
const mockFstat = vi.mocked(fs.fstatSync);
const mockLstat = vi.mocked(fs.lstatSync);
const TWO_53 = 2n ** 53n;

// A stat result reduced to device and inode, in the form the caller asked
// for: exact bigint, or the default double that rounds above 2^53.
function statAs(options: unknown, dev: bigint, ino: bigint): { dev: bigint | number; ino: bigint | number } {
  const exact = (options as { bigint?: boolean } | undefined)?.bigint === true;
  return exact ? { dev, ino } : { dev: Number(dev), ino: Number(ino) };
}
const fixedHex = 'ab'.repeat(8);
const isWindows = process.platform === 'win32';
const postCommitFailures: ReadonlyArray<'rename' | 'directory fsync'> = isWindows
  ? ['rename'] : ['rename', 'directory fsync'];

function plantFileAlias(target: string, alias: string): void {
  if (isWindows) fs.linkSync(target, alias);
  else fs.symlinkSync(target, alias);
}

function expectFileAlias(alias: string, target: string): void {
  if (isWindows) expect(fs.statSync(alias, { bigint: true }).ino).toBe(fs.statSync(target, { bigint: true }).ino);
  else expect(fs.readlinkSync(alias)).toBe(target);
}

describe('writeBytesAtomicDurable staging file', () => {
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
  // Puts another file at `name` by renaming over it, so the replacement holds
  // a different inode even when the staged file is no longer open.
  function replaceWithForeign(name: string): void {
    const foreign = path.join(dir, 'foreign-file');
    fs.writeFileSync(foreign, 'NOT OURS');
    // Windows MoveFileEx cannot replace an open destination. The foreign inode
    // already exists before unlinking, so this retains the distinct-identity
    // attack while exercising the native delete-sharing path.
    if (isWindows) fs.unlinkSync(name);
    fs.renameSync(foreign, name);
  }

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-staging-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-staging-outside-')));
    file = path.join(dir, 'state.json');
    mockRandomBytes.mockReset(); // back to the real randomBytes
    mockFstat.mockReset(); // back to the real fstatSync
    mockLstat.mockReset(); // back to the real lstatSync
  });

  afterEach(() => {
    restoreHook?.();
    restoreHook = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('does not write through a link planted at the old predictable staging name', () => {
    // The old name was pid + millisecond clock; pin the clock and plant a
    // link at exactly that name.
    const now = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    const predictable = `${file}.tmp.${process.pid}.${now}`;
    plantFileAlias(victim, predictable);
    try {
      writeBytesAtomicDurable(file, 'payload');
    } finally {
      nowSpy.mockRestore();
    }

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toBe('payload');
    expectFileAlias(predictable, victim);
  });

  it('refuses to stage through an entry already present at the fresh staging name', () => {
    // Force the staging name, then plant a link there: the exclusive create
    // must fail instead of following the link.
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    mockRandomBytes.mockImplementationOnce(() => Buffer.from(fixedHex, 'hex'));
    const staging = `${file}.tmp.${process.pid}.${fixedHex}`;
    plantFileAlias(victim, staging);

    expect(() => writeBytesAtomicDurable(file, 'payload', 0o600)).toThrow(/EEXIST/);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expectFileAlias(staging, victim);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes its staging file when the write or the close fails', () => {
    for (const failAt of ['write', 'close'] as const) {
      hook(event => {
        if (event.kind === failAt) throw new Error(`injected ${failAt} failure`);
      });
      expect(() => writeBytesAtomicDurable(file, 'payload')).toThrow(`injected ${failAt} failure`);
      restoreHook?.();
      restoreHook = undefined;

      expect(fs.readdirSync(dir)).toEqual([]);
    }
  });

  it('leaves an entry that replaced its staging file before the write failed', () => {
    hook(event => {
      if (event.kind !== 'write') return;
      const [name] = stagingEntries();
      replaceWithForeign(path.join(dir, name));
      throw new Error('injected write failure');
    });

    expect(() => writeBytesAtomicDurable(file, 'payload')).toThrow('injected write failure');

    const staging = stagingEntries();
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });

  it('compares the staged file identity exactly, also for inode numbers above 2^53', () => {
    // The staged file reports inode 2^53 and the entry that replaces it
    // 2^53 + 1: different numbers that agree once rounded to a double. The
    // failure that follows must still leave the replacement in place.
    let ours: bigint | undefined;
    mockFstat.mockImplementation(((fd: number, options?: unknown) => {
      const real = actualFs.fstatSync(fd, { bigint: true });
      ours = real.ino;
      return statAs(options, real.dev, TWO_53);
    }) as typeof fs.fstatSync);
    mockLstat.mockImplementation(((target: fs.PathLike, options?: unknown) => {
      const real = actualFs.lstatSync(target, { bigint: true });
      return statAs(options, real.dev, real.ino === ours ? TWO_53 : TWO_53 + 1n);
    }) as typeof fs.lstatSync);
    hook(event => {
      if (event.kind !== 'write') return;
      const [name] = stagingEntries();
      replaceWithForeign(path.join(dir, name));
      throw new Error('injected write failure');
    });

    expect(() => writeBytesAtomicDurable(file, 'payload')).toThrow('injected write failure');

    expect(ours).toBeDefined();
    const staging = stagingEntries();
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });

  it('removes a file by identity only while the name still holds that file', () => {
    const fd = fs.openSync(file, 'wx');
    const identity = fileIdentityOfFd(fd);
    fs.closeSync(fd);
    expect(typeof identity.ino).toBe('bigint');

    // A symbolic link/junction has its own identity rather than its target's.
    const link = path.join(dir, 'link');
    fs.symlinkSync(isWindows ? outside : file, link, isWindows ? 'junction' : 'file');
    unlinkIfSameFile(link, identity);
    expect(fs.realpathSync(link)).toBe(isWindows ? outside : file);
    // Nothing is removed without a recorded identity, or for another file.
    unlinkIfSameFile(file, undefined);
    const other = path.join(dir, 'other');
    fs.writeFileSync(other, 'other');
    unlinkIfSameFile(other, identity);
    expect(fs.readdirSync(dir).sort()).toEqual(['link', 'other', 'state.json']);
    // The identified file itself is removed; a missing name is no error.
    unlinkIfSameFile(file, identity);
    unlinkIfSameFile(file, identity);
    expect(fs.readdirSync(dir).sort()).toEqual(['link', 'other']);
  });

  it('leaves an entry that replaced its staging file before the commit guard refused', () => {
    expect(() => writeBytesAtomicDurable(file, 'payload', undefined, () => {
      const [name] = stagingEntries();
      replaceWithForeign(path.join(dir, name));
      throw new Error('guard refused');
    })).toThrow('guard refused');

    const staging = stagingEntries();
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, staging[0]), 'utf-8')).toBe('NOT OURS');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('removes its staging file when the final rename fails', () => {
    // A non-empty directory at the target makes the rename fail after the
    // whole payload has been staged.
    fs.mkdirSync(path.join(file, 'inner'), { recursive: true });

    expect(() => writeBytesAtomicDurable(file, 'payload')).toThrow(/rename/);

    expect(fs.readdirSync(dir)).toEqual(['state.json']);
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it('leaves an entry that replaced its staging file before the final rename failed', () => {
    fs.mkdirSync(path.join(file, 'inner'), { recursive: true });

    expect(() => writeBytesAtomicDurable(file, 'payload', undefined, () => {
      const [name] = stagingEntries();
      replaceWithForeign(path.join(dir, name));
    })).toThrow(/rename/);

    const staging = stagingEntries();
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });

  it('leaves whatever takes the vacated staging name after a completed rename', () => {
    // The rename succeeds and a later step then fails (the audit record of the
    // rename, or the directory fsync); by then the vacated staging name holds
    // an entry this call did not create: another file, a link to the very
    // file it staged, or such a link with the target itself removed again.
    const takeVacatedName = [
      (staging: string) => fs.writeFileSync(staging, 'NOT OURS'),
      (staging: string) => fs.linkSync(file, staging),
      (staging: string) => { fs.linkSync(file, staging); fs.unlinkSync(file); },
    ];
    for (const failAt of postCommitFailures) {
      for (const take of takeVacatedName) {
        fs.rmSync(dir, { recursive: true, force: true });
        let staging: string | undefined;
        hook(event => {
          if (event.kind === 'rename') staging = event.from;
          const hit = failAt === 'rename'
            ? event.kind === 'rename'
            : staging !== undefined && event.kind === 'fsync' && fs.fstatSync(event.fd).isDirectory();
          if (!hit) return;
          expect(fs.existsSync(staging!)).toBe(false); // the rename has happened
          take(staging!);
          throw new Error(`injected ${failAt} failure`);
        });

        expect(() => writeBytesAtomicDurable(file, 'payload')).toThrow(`injected ${failAt} failure`);
        restoreHook?.();
        restoreHook = undefined;

        expect(stagingEntries()).toEqual([path.basename(staging!)]);
      }
    }
  });
});

describe('commitStagedDurable rename-failure callback', () => {
  let dir: string;
  let staged: string;
  let final: string;
  let restoreHook: (() => void) | undefined;

  beforeEach(() => {
    dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-commit-')));
    staged = path.join(dir, 'state.json.next');
    final = path.join(dir, 'state.json');
    fs.writeFileSync(staged, 'staged');
  });

  afterEach(() => {
    restoreHook?.();
    restoreHook = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the callback when the rename fails, then rethrows', () => {
    fs.mkdirSync(path.join(final, 'inner'), { recursive: true });
    const onRenameFailed = vi.fn(() => fs.unlinkSync(staged));

    expect(() => commitStagedDurable(staged, final, onRenameFailed)).toThrow(/rename/);

    expect(onRenameFailed).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(dir)).toEqual(['state.json']);
  });

  it('runs the callback when the same-parent guard refuses', () => {
    const onRenameFailed = vi.fn();

    expect(() => commitStagedDurable(staged, path.join(dir, 'sub', 'state.json'), onRenameFailed))
      .toThrow(/same parent directory/);

    expect(onRenameFailed).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(staged, 'utf-8')).toBe('staged');
  });

  it('never runs the callback once the rename has returned', () => {
    for (const failAt of postCommitFailures) {
      fs.writeFileSync(staged, 'staged');
      let renamed = false;
      restoreHook = _setAtomicWriteAuditHook(event => {
        if (event.kind === 'rename') renamed = true;
        const hit = failAt === 'rename' ? event.kind === 'rename' : renamed && event.kind === 'fsync';
        if (hit) throw new Error(`injected ${failAt} failure`);
      });
      const onRenameFailed = vi.fn();

      expect(() => commitStagedDurable(staged, final, onRenameFailed)).toThrow(`injected ${failAt} failure`);
      restoreHook();
      restoreHook = undefined;

      expect(onRenameFailed).not.toHaveBeenCalled();
      expect(fs.readFileSync(final, 'utf-8')).toBe('staged');
      expect(fs.existsSync(staged)).toBe(false);
    }
  });
});
