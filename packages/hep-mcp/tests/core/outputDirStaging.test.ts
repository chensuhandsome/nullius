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
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const closeSync = (fd: number): void => {
    actual.closeSync(fd);
    if (closeFault.armed) {
      closeFault.armed = false;
      throw Object.assign(new Error('simulated close failure'), { code: 'EIO' });
    }
  };
  const fstatSync = ((fd: number, options?: any) => {
    if (fstatFault.armed) {
      fstatFault.armed = false;
      throw Object.assign(new Error('simulated fstat failure'), { code: 'EIO' });
    }
    return actual.fstatSync(fd, options);
  }) as typeof actual.fstatSync;
  const linkSync = (existing: string, target: string): void => {
    linkFault.calls += 1;
    if (linkFault.calls === linkFault.failOnCall) {
      linkFault.before();
      throw Object.assign(new Error('simulated link failure'), { code: 'EIO' });
    }
    actual.linkSync(existing, target);
  };
  const patched = { closeSync, fstatSync, linkSync };
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
      expect(() => new OutputBatch(out).json('data.json', { x: 1 })).toThrow(/could not be identified and was left in place/);
      expect(fs.readdirSync(out.dir).filter(name => name.endsWith('.tmp'))).toHaveLength(1);
    });
  });

  it('reports the files it could not remove when publishing fails, instead of claiming all or none', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('stuck');
      const batch = new OutputBatch(out);
      batch.json('a.json', { x: 1 });
      batch.json('b.json', { x: 2 });
      linkFault.failOnCall = 2;
      linkFault.before = () => fs.chmodSync(out.dir, 0o555);
      try {
        const error = await batch.publish().then(() => null, (e: unknown) => e as { message: string; data?: { files_left?: string[] } });
        expect(error?.message).toMatch(/outputs are incomplete/);
        expect(error?.data?.files_left).toEqual(['stuck/a.json']);
      } finally {
        fs.chmodSync(out.dir, 0o755);
      }
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
});
