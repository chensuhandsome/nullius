import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Pin the staging-name randomness so a test can plant an entry at the exact
// staging path a write will use.
vi.mock('crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => '00000000-0000-4000-8000-000000000000' };
});

// Let a test make the next closeSync or fstatSync fail, or run a step
// before a given linkSync call fails.
const closeFault = vi.hoisted(() => ({ armed: false }));
const fstatFault = vi.hoisted(() => ({ armed: false }));
const linkFault = vi.hoisted(() => ({ failOnCall: 0, calls: 0, before: (() => {}) as () => void }));
const unlinkFault = vi.hoisted(() => ({ failNext: 0 }));
const writeFault = vi.hoisted(() => ({ armed: false }));
const fsyncFault = vi.hoisted(() => ({ armed: false }));
const closeCount = vi.hoisted(() => ({ calls: 0 }));
// Report a huge inode: 2^53 for a descriptor, 2^53 + 1 for a staging path.
// As JavaScript numbers the two are equal; as exact integers they differ.
const inodeFake = vi.hoisted(() => ({ armed: false }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const closeSync = (fd: number): void => {
    closeCount.calls += 1;
    actual.closeSync(fd);
    if (closeFault.armed) {
      closeFault.armed = false;
      throw Object.assign(new Error('simulated close failure'), { code: 'EIO' });
    }
  };
  const withInode = (stat: any, big: bigint, asBigint: boolean) =>
    Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: asBigint ? big : Number(big) });
  const fstatSync = ((fd: number, options?: any) => {
    if (fstatFault.armed) {
      fstatFault.armed = false;
      throw Object.assign(new Error('simulated fstat failure'), { code: 'EIO' });
    }
    const stat = actual.fstatSync(fd, options);
    return inodeFake.armed ? withInode(stat, 2n ** 53n, Boolean(options?.bigint)) : stat;
  }) as typeof actual.fstatSync;
  const lstatSync = ((target: string, options?: any) => {
    const stat = actual.lstatSync(target, options);
    return inodeFake.armed && String(target).endsWith('.tmp') ? withInode(stat, 2n ** 53n + 1n, Boolean(options?.bigint)) : stat;
  }) as typeof actual.lstatSync;
  const fsyncSync = (fd: number): void => {
    if (fsyncFault.armed) {
      fsyncFault.armed = false;
      throw Object.assign(new Error('simulated fsync failure'), { code: 'EIO' });
    }
    actual.fsyncSync(fd);
  };
  const linkSync = (existing: string, target: string): void => {
    linkFault.calls += 1;
    if (linkFault.calls === linkFault.failOnCall) {
      linkFault.before();
      throw Object.assign(new Error('simulated link failure'), { code: 'EIO' });
    }
    actual.linkSync(existing, target);
  };
  const unlinkSync = (target: string): void => {
    if (unlinkFault.failNext > 0) {
      unlinkFault.failNext -= 1;
      throw Object.assign(new Error('simulated unlink failure'), { code: 'EIO' });
    }
    actual.unlinkSync(target);
  };
  const writeSync = ((fd: number, ...rest: any[]) => {
    if (writeFault.armed) {
      writeFault.armed = false;
      throw Object.assign(new Error('simulated write failure'), { code: 'ENOSPC' });
    }
    return (actual.writeSync as any)(fd, ...rest);
  }) as typeof actual.writeSync;
  const patched = { closeSync, fstatSync, fsyncSync, linkSync, lstatSync, unlinkSync, writeSync };
  return { ...actual, ...patched, default: { ...actual, ...patched } };
});

const { withHepDataRoot } = await import('../../src/data/dataDir.js');
const { OutputBatch, resolveOutputDir } = await import('../../src/core/outputDir.js');
const { makeProjectRoot } = await import('../support/hepProjectUri.js');

describe('output staging files are created exclusively', () => {
  let tmpDir: string;
  let alias: string;

  beforeEach(() => {
    closeFault.armed = false;
    fstatFault.armed = false;
    linkFault.failOnCall = 0;
    linkFault.calls = 0;
    linkFault.before = () => {};
    unlinkFault.failNext = 0;
    writeFault.armed = false;
    fsyncFault.armed = false;
    inodeFake.armed = false;
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-staging-')));
    const projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not open or follow an entry planted at the staging path, and leaves its target untouched', async () => {
    const victim = path.join(tmpDir, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('out');
      const staging = path.join(out.dir, `.data.json.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`);
      fs.symlinkSync(victim, staging, 'file');
      expect(() => new OutputBatch(out).json('data.json', { x: 1 })).toThrow(/EEXIST/);
      expect(fs.existsSync(path.join(out.dir, 'data.json'))).toBe(false);
      expect(fs.lstatSync(staging).isSymbolicLink()).toBe(true);
    });
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original');
  });

  it('removes the staging file when closing it fails, and reports that failure', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('closing');
      const batch = new OutputBatch(out);
      closeFault.armed = true;
      expect(() => batch.json('data.json', { x: 1 })).toThrow('simulated close failure');
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('names a staging file that was created but could not be identified', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('unidentified');
      fstatFault.armed = true;
      let thrown: (Error & { code?: string; data?: { staging_path?: string } }) | undefined;
      try { new OutputBatch(out).json('data.json', { x: 1 }); } catch (error) { thrown = error as typeof thrown; }
      expect(thrown?.message).toMatch(/could not be identified and was left in place/);
      expect(thrown?.code).toBe('UNSAFE_FS');
      expect(thrown?.data?.staging_path).toBe(`unidentified/.data.json.${process.pid}.00000000-0000-4000-8000-000000000000.tmp`);
      expect(fs.readdirSync(out.dir).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
    });
  });

  // Root ignores directory permissions, so this case cannot be built there.
  it.skipIf(process.getuid?.() === 0)('reports the files it could not remove when publishing fails, instead of claiming all or none', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('stuck');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('b.json', { x: 2 });
      linkFault.failOnCall = 2;
      linkFault.before = () => fs.chmodSync(out.dir, 0o555);
      try {
        const error = await batch.publish().then(() => null, (e: unknown) => e as { message: string; code?: string; data?: { files_left?: string[] } });
        expect(error?.code).toBe('UNSAFE_FS');
        expect(error?.message).toMatch(/outputs are incomplete/);
        expect(error?.data?.files_left).toEqual(['stuck/a.json']);
        expect((error?.data as { staging_left?: string[] } | undefined)?.staging_left).toHaveLength(2);
      } finally {
        fs.chmodSync(out.dir, 0o755);
      }
    });
  });

  // Root ignores directory permissions, so this case cannot be built there.
  it.skipIf(process.getuid?.() === 0)('names the staging files it could not remove when a call is discarded, keeping the original error', async () => {
    const { McpError } = await import('@nullius/shared');
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('kept');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.openFile('b.jsonl', 'application/x-ndjson');
      fs.chmodSync(out.dir, 0o555);
      try {
        const reported = batch.discard(new McpError('INVALID_PARAMS', 'the original failure', { detail: 1 })) as InstanceType<typeof McpError>;
        expect(reported).toBeInstanceOf(McpError);
        expect(reported.code).toBe('INVALID_PARAMS');
        expect(reported.message).toMatch(/^the original failure; staging files could not be removed/);
        expect(reported.data).toMatchObject({ detail: 1 });
        expect((reported.data as { staging_left: string[] }).staging_left).toHaveLength(2);
      } finally {
        fs.chmodSync(out.dir, 0o755);
      }
    });
  });

  it('returns the original error unchanged when discarding leaves nothing behind', async () => {
    await withHepDataRoot(alias, async () => {
      const batch = new OutputBatch(resolveOutputDir('clean'));
      batch.json('a.json', { x: 1 });
      const cause = new Error('plain failure');
      expect(batch.discard(cause)).toBe(cause);
    });
  });

  it('removes what it published when a later link fails, and leaves no staging file', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('undone');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('b.json', { x: 2 });
      linkFault.failOnCall = 2;
      await expect(batch.publish()).rejects.toThrow('simulated link failure');
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('reports a staging file that a failed write could not remove, when the call is discarded', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('write-kept');
      const batch = new OutputBatch(out);
      closeFault.armed = true;
      unlinkFault.failNext = 2;
      let thrown: unknown;
      try { batch.json('data.json', { x: 1 }); } catch (error) { thrown = error; }
      expect((thrown as Error).message).toBe('simulated close failure');
      const reported = batch.discard(thrown) as Error & { data?: { staging_left?: string[] } };
      expect(reported.message).toMatch(/^simulated close failure; staging files could not be removed/);
      expect(reported.data?.staging_left).toHaveLength(1);
    });
  });

  it('returns the original error, with no stale leftover claim, when a later cleanup attempt succeeds', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('write-retried');
      const batch = new OutputBatch(out);
      closeFault.armed = true;
      unlinkFault.failNext = 1;
      let thrown: unknown;
      try { batch.json('data.json', { x: 1 }); } catch (error) { thrown = error; }
      expect(batch.discard(thrown)).toBe(thrown);
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('builds the publication failure report after the last cleanup attempt, and later discards keep it', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('publish-retried');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('b.json', { x: 2 });
      linkFault.failOnCall = 2;
      // The rollback's first attempt to remove the published a.json fails once.
      linkFault.before = () => { unlinkFault.failNext = 1; };
      const error = await batch.publish().then(() => null, (e: unknown) => e as Error & { data?: Record<string, unknown> });
      expect(error?.message).toBe('simulated link failure');
      expect(error?.data).toBeUndefined();
      expect(batch.discard(error)).toBe(error);
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('throws a failed piecewise write at once and removes its staging file', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('midway');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      writeFault.armed = true;
      expect(() => file.write('{"b":2}\n')).toThrow('simulated write failure');
      expect(() => file.finish()).toThrow(/already finished or discarded/);
      expect(fs.readdirSync(out.dir)).toEqual([]);
      const cause = new Error('cause');
      expect(batch.discard(cause)).toBe(cause);
    });
  });

  it('reports a piecewise file whose staging file a failed write could not remove, when the call is discarded', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('write-file-kept');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      // Every removal attempt fails: the write's own cleanup and discard.
      unlinkFault.failNext = 100;
      try {
        writeFault.armed = true;
        let thrown: unknown;
        try { file.write('{"a":1}\n'); } catch (error) { thrown = error; }
        expect((thrown as Error).message).toBe('simulated write failure');
        const reported = batch.discard(thrown) as Error & { data?: { staging_left?: string[] } };
        expect(reported.message).toMatch(/^simulated write failure; staging files could not be removed/);
        expect(reported.data?.staging_left).toHaveLength(1);
      } finally {
        unlinkFault.failNext = 0;
      }
    });
  });

  it('keeps a final report true: a later discard neither retries nor changes it, and the files it names exist', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('report-kept');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('b.json', { x: 2 });
      linkFault.failOnCall = 2;
      linkFault.before = () => { unlinkFault.failNext = 100; };
      const error = await batch.publish().then(() => null, (e: unknown) => e as Error & { data?: { files_left?: string[]; staging_left?: string[] } });
      unlinkFault.failNext = 0;
      expect(error?.message).toMatch(/outputs are incomplete/);
      expect(batch.discard(error)).toBe(error);
      const named = [...(error?.data?.files_left ?? []), ...(error?.data?.staging_left ?? [])];
      expect(named.length).toBeGreaterThan(0);
      for (const rel of named) expect(fs.existsSync(path.join(out.projectRoot, rel)), rel).toBe(true);
    });
  });

  it('closes the file when flushing it fails, and refuses to write or finish it afterwards', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('fsync-failed');
      const batch = new OutputBatch(out);
      const file = batch.openFile('records.jsonl', 'application/x-ndjson');
      file.write('{"a":1}\n');
      fsyncFault.armed = true;
      const before = closeCount.calls;
      expect(() => file.finish()).toThrow('simulated fsync failure');
      expect(closeCount.calls - before).toBe(1);
      expect(() => file.write('{"b":2}\n')).toThrow(/already finished or discarded/);
      expect(() => file.finish()).toThrow(/already finished or discarded/);
      expect(fs.readdirSync(out.dir)).toEqual([]);
    });
  });

  it('compares file identities as exact 64-bit integers, so inodes 2^53 and 2^53 + 1 differ', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('big-inode');
      const batch = new OutputBatch(out);
      inodeFake.armed = true;
      try {
        batch.json('a.json', { x: 1 });
        await expect(batch.publish()).rejects.toThrow(/staged output file was replaced/);
      } finally {
        inodeFake.armed = false;
      }
      expect(fs.existsSync(path.join(out.dir, 'a.json'))).toBe(false);
    });
  });
});
