import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, closeSync: vi.fn(actual.closeSync) };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

import { randomBytes } from 'crypto';
import { IdeaEngineStore } from '../src/store/engine-store.js';

const mockRandomBytes = vi.mocked(randomBytes);
const mockClose = vi.mocked(fs.closeSync);
const { closeSync: actualCloseSync } = await vi.importActual<typeof import('fs')>('fs');
const fixedHex = 'ab'.repeat(8);
const CAMPAIGN_ID = 'stagecmp';

// The next closeSync really closes its descriptor and then reports failure.
function failNextClose(): void {
  mockClose.mockImplementationOnce((fd: number) => {
    actualCloseSync(fd);
    throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
  });
}

function campaign(extra: Record<string, unknown> = {}): Record<string, unknown> & { campaign_id: string } {
  return { campaign_id: CAMPAIGN_ID, status: 'running', ...extra };
}

describe('store JSON writes stage at a fresh exclusive name', () => {
  let rootDir: string;
  let outside: string;
  let store: IdeaEngineStore;
  let campaignDir: string;
  let manifest: string;

  beforeEach(() => {
    rootDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-engine-staging-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'idea-engine-outside-')));
    store = new IdeaEngineStore(rootDir);
    campaignDir = store.campaignDir(CAMPAIGN_ID);
    manifest = store.campaignManifestPath(CAMPAIGN_ID);
    fs.mkdirSync(campaignDir, { recursive: true });
    mockRandomBytes.mockReset(); // back to the real randomBytes
    mockClose.mockReset(); // back to the real closeSync
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('does not write through a link left at the old fixed staging name', () => {
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    const target = process.platform === 'win32' ? outside : victim;
    fs.symlinkSync(target, `${manifest}.tmp`, process.platform === 'win32' ? 'junction' : 'file');

    store.saveCampaign(campaign());

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.lstatSync(manifest).isFile()).toBe(true);
    expect(store.loadCampaign(CAMPAIGN_ID)).toEqual(campaign());
    expect(fs.realpathSync(`${manifest}.tmp`)).toBe(fs.realpathSync(target));
  });

  it('refuses to stage through an entry already present at the fresh staging name', () => {
    // Force the staging name, then plant a link there: the exclusive create
    // must fail instead of following the link out of the store.
    const victim = path.join(outside, 'victim.json');
    fs.writeFileSync(victim, 'ORIGINAL');
    mockRandomBytes.mockImplementationOnce(() => Buffer.from(fixedHex, 'hex'));
    const staging = `${manifest}.${process.pid}.${fixedHex}.tmp`;
    const target = process.platform === 'win32' ? outside : victim;
    fs.symlinkSync(target, staging, process.platform === 'win32' ? 'junction' : 'file');

    expect(() => store.saveCampaign(campaign())).toThrow(/EEXIST/);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.realpathSync(staging)).toBe(fs.realpathSync(target));
    expect(fs.existsSync(manifest)).toBe(false);
  });

  it('removes its staging file when the write fails', () => {
    // A BigInt cannot be serialized, so the write fails after the staging
    // file has been created.
    expect(() => store.saveCampaign(campaign({ count: 1n }))).toThrow(/BigInt/);

    expect(fs.readdirSync(campaignDir)).toEqual([]);
  });

  it('removes its staging file when closing it fails, after a failed or a complete write', () => {
    failNextClose();

    expect(() => store.saveCampaign(campaign({ count: 1n }))).toThrow(/BigInt/);

    expect(fs.readdirSync(campaignDir)).toEqual([]);

    failNextClose();

    expect(() => store.saveCampaign(campaign())).toThrow(/injected close failure/);

    expect(fs.readdirSync(campaignDir)).toEqual([]);
  });

  it('leaves an entry that replaced its staging file before the write failed', () => {
    // While the payload is serialized, the staging name is taken over by
    // another file; the failure that follows must not remove that file.
    const payload = campaign({
      hook: {
        toJSON() {
          const [name] = fs.readdirSync(campaignDir).filter((entry) => entry.endsWith('.tmp'));
          fs.unlinkSync(path.join(campaignDir, name));
          fs.writeFileSync(path.join(campaignDir, name), 'NOT OURS');
          throw new Error('serialization failed');
        },
      },
    });

    expect(() => store.saveCampaign(payload)).toThrow(/serialization failed/);

    const staging = fs.readdirSync(campaignDir).filter((name) => name.endsWith('.tmp'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(campaignDir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });

  it('removes its staging file when the final rename fails', () => {
    // A non-empty directory at the target makes the rename fail after the
    // whole payload has been staged.
    fs.mkdirSync(path.join(manifest, 'inner'), { recursive: true });

    expect(() => store.saveCampaign(campaign())).toThrow(/rename/);

    expect(fs.readdirSync(campaignDir)).toEqual(['campaign.json']);
    expect(fs.statSync(manifest).isDirectory()).toBe(true);
  });
});
