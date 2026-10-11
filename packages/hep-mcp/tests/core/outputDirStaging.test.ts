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

// Let a test make the next closeSync fail after the descriptor is closed.
const closeFault = vi.hoisted(() => ({ armed: false }));
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>();
  const closeSync = (fd: number): void => {
    actual.closeSync(fd);
    if (closeFault.armed) {
      closeFault.armed = false;
      throw Object.assign(new Error('simulated close failure'), { code: 'EIO' });
    }
  };
  return { ...actual, closeSync, default: { ...actual, closeSync } };
});

const { withHepDataRoot } = await import('../../src/data/dataDir.js');
const { OutputBatch, resolveOutputDir } = await import('../../src/core/outputDir.js');
const { makeProjectRoot } = await import('../support/hepProjectUri.js');

describe('output staging files are created exclusively', () => {
  let tmpDir: string;
  let alias: string;

  beforeEach(() => {
    closeFault.armed = false;
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
});
