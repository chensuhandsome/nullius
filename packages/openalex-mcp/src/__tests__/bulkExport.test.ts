import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/rateLimiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/rateLimiter.js')>()),
  openalexFetch: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, closeSync: vi.fn(actual.closeSync) };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});
vi.mock('@nullius/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nullius/shared')>();
  return { ...actual, uniqueShortId: vi.fn(actual.uniqueShortId) };
});

import { randomBytes } from 'crypto';
import { _setAtomicWriteAuditHook, uniqueShortId } from '@nullius/shared';
import { handleSearch } from '../api/client.js';
import { openalexFetch } from '../api/rateLimiter.js';

const mockFetch = vi.mocked(openalexFetch);
const mockRandomBytes = vi.mocked(randomBytes);
const mockShortId = vi.mocked(uniqueShortId);
const mockClose = vi.mocked(fs.closeSync);
const { closeSync: actualCloseSync } = await vi.importActual<typeof import('fs')>('fs');
const ORIGINAL_OPENALEX_DATA_DIR = process.env.OPENALEX_DATA_DIR;
const FILE_ID = 'FIXEDID1';
const fixedHex = 'ab'.repeat(8);

// Native Windows hard links exercise the same no-write-through/identity
// contract without requiring the symbolic-link privilege.
function plantFileLink(target: string, entry: string): void {
  if (process.platform === 'win32') fs.linkSync(target, entry);
  else fs.symlinkSync(target, entry);
}

function expectFileLink(entry: string, target: string): void {
  if (process.platform === 'win32') expect(fs.statSync(entry).ino).toBe(fs.statSync(target).ino);
  else expect(fs.readlinkSync(entry)).toBe(target);
}

function page(ids: string[], nextCursor: string | null): Response {
  return new Response(JSON.stringify({
    meta: { count: 4, page: 1, per_page: ids.length, next_cursor: nextCursor },
    results: ids.map((id) => ({ id: `https://openalex.org/${id}`, title: `Work ${id}` })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// Two pages of two works each: the export runs in bulk mode and ends on the
// second page. `beforeLast` runs just before the second page is served.
function serveTwoPages(beforeLast?: () => void): void {
  mockFetch
    .mockImplementationOnce(async () => page(['W1', 'W2'], 'next'))
    .mockImplementationOnce(async () => {
      beforeLast?.();
      return page(['W3', 'W4'], null);
    });
}

// The next closeSync really closes its descriptor and then reports failure.
function failNextClose(): void {
  mockClose.mockImplementationOnce((fd: number) => {
    actualCloseSync(fd);
    throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
  });
}

function exportAll() {
  return handleSearch({ query: 'bulk', per_page: 2, page: 1, max_results: 4 });
}

describe('bulk JSONL export staging', () => {
  let dataDir: string;
  let outside: string;
  let resultsDir: string;

  beforeEach(() => {
    // Real paths, so the data dir itself is not reached through an alias.
    dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-bulk-data-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-bulk-outside-')));
    resultsDir = path.join(dataDir, 'results');
    process.env.OPENALEX_DATA_DIR = dataDir;
    mockFetch.mockReset();
    mockRandomBytes.mockReset(); // back to the real randomBytes
    mockShortId.mockReset(); // back to the real uniqueShortId
    mockClose.mockReset(); // back to the real closeSync
  });

  afterEach(() => {
    if (ORIGINAL_OPENALEX_DATA_DIR === undefined) delete process.env.OPENALEX_DATA_DIR;
    else process.env.OPENALEX_DATA_DIR = ORIGINAL_OPENALEX_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('does not write through a link left at the old fixed staging name', async () => {
    fs.mkdirSync(resultsDir);
    const victim = path.join(outside, 'victim.jsonl');
    fs.writeFileSync(victim, 'ORIGINAL');
    plantFileLink(victim, path.join(resultsDir, `${FILE_ID}.jsonl.tmp`));
    mockShortId.mockImplementationOnce(() => FILE_ID);
    serveTwoPages();

    const result = await exportAll();

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(result.results_file).toBe(path.join(resultsDir, `${FILE_ID}.jsonl`));
    expect(fs.lstatSync(result.results_file!).isFile()).toBe(true);
    expect(fs.readFileSync(result.results_file!, 'utf-8').trim().split('\n')).toHaveLength(4);
    expectFileLink(path.join(resultsDir, `${FILE_ID}.jsonl.tmp`), victim);
  });

  it('refuses to stage through an entry already present at the fresh staging name', async () => {
    // Force the staging name, then plant a link there: the exclusive create
    // must fail instead of following the link out of the data dir.
    fs.mkdirSync(resultsDir);
    const victim = path.join(outside, 'victim.jsonl');
    fs.writeFileSync(victim, 'ORIGINAL');
    mockShortId.mockImplementationOnce(() => FILE_ID);
    mockRandomBytes.mockImplementationOnce(() => Buffer.from(fixedHex, 'hex'));
    const staging = path.join(resultsDir, `${FILE_ID}.jsonl.${process.pid}.${fixedHex}.tmp`);
    plantFileLink(victim, staging);
    serveTwoPages();

    await expect(exportAll()).rejects.toThrow(/EEXIST/);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expectFileLink(staging, victim);
    expect(fs.existsSync(path.join(resultsDir, `${FILE_ID}.jsonl`))).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses a results dir that is a link out of the data dir', async () => {
    fs.symlinkSync(outside, resultsDir, process.platform === 'win32' ? 'junction' : 'dir');
    serveTwoPages();

    await expect(exportAll()).rejects.toThrow(/results dir: symlink escape detected/);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts a results dir reached through a link inside the data dir, also when the data dir is an alias', async () => {
    // An explicit alias, so this holds on hosts whose temp dir is not itself
    // a symlink (Linux) as well as under /var -> /private/var (macOS).
    fs.mkdirSync(path.join(dataDir, 'real-results'));
    fs.symlinkSync(path.join(dataDir, 'real-results'), resultsDir, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasHolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-bulk-alias-')));
    try {
      const aliasData = path.join(aliasHolder, 'data');
      fs.symlinkSync(dataDir, aliasData, process.platform === 'win32' ? 'junction' : 'dir');
      process.env.OPENALEX_DATA_DIR = aliasData;
      serveTwoPages();
      serveTwoPages();

      const first = await exportAll();
      const second = await exportAll();

      for (const result of [first, second]) {
        expect(path.dirname(result.results_file!)).toBe(path.join(aliasData, 'results'));
      }
      expect(fs.readdirSync(path.join(dataDir, 'real-results')).sort()).toEqual(
        [path.basename(first.results_file!), path.basename(second.results_file!)].sort(),
      );
    } finally {
      fs.rmSync(aliasHolder, { recursive: true, force: true });
    }
  });

  it('removes its staging file when the export fails midway', async () => {
    mockFetch
      .mockImplementationOnce(async () => page(['W1', 'W2'], 'next'))
      .mockImplementationOnce(async () => new Response('upstream down', { status: 500 }));

    await expect(exportAll()).rejects.toThrow(/HTTP 500/);

    expect(fs.readdirSync(resultsDir)).toEqual([]);
  });

  it('removes its staging file when closing it fails, after a failed or a complete export', async () => {
    mockFetch
      .mockImplementationOnce(async () => page(['W1', 'W2'], 'next'))
      .mockImplementationOnce(async () => {
        failNextClose();
        return new Response('upstream down', { status: 500 });
      });

    await expect(exportAll()).rejects.toThrow(/HTTP 500/);

    expect(fs.readdirSync(resultsDir)).toEqual([]);

    serveTwoPages(failNextClose);

    await expect(exportAll()).rejects.toThrow(/injected close failure/);

    expect(fs.readdirSync(resultsDir)).toEqual([]);
  });

  it('leaves an entry that replaced its staging file before the export failed', async () => {
    // Between pages the staging name is taken over by another file; the
    // upstream failure that follows must not remove that file.
    mockFetch
      .mockImplementationOnce(async () => page(['W1', 'W2'], 'next'))
      .mockImplementationOnce(async () => {
        const [name] = fs.readdirSync(resultsDir).filter((entry) => entry.endsWith('.tmp'));
        fs.unlinkSync(path.join(resultsDir, name));
        fs.writeFileSync(path.join(resultsDir, name), 'NOT OURS');
        return new Response('upstream down', { status: 500 });
      });

    await expect(exportAll()).rejects.toThrow(/HTTP 500/);

    const staging = fs.readdirSync(resultsDir).filter((name) => name.endsWith('.tmp'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(resultsDir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });

  it('removes its staging file when the final rename fails', async () => {
    // A non-empty directory appears at the export's name while the last page
    // is fetched, so the rename fails after every result has been staged.
    mockShortId.mockImplementationOnce(() => FILE_ID);
    serveTwoPages(() => fs.mkdirSync(path.join(resultsDir, `${FILE_ID}.jsonl`, 'inner'), { recursive: true }));

    await expect(exportAll()).rejects.toThrow(/rename/);

    expect(fs.readdirSync(resultsDir)).toEqual([`${FILE_ID}.jsonl`]);
    expect(fs.statSync(path.join(resultsDir, `${FILE_ID}.jsonl`)).isDirectory()).toBe(true);
  });

  it('leaves whatever takes the vacated staging name after a completed rename', async () => {
    // The rename succeeds and a later step then fails (the audit record of the
    // rename, or the directory fsync); by then the vacated staging name holds
    // an entry this export did not create: another file, a link to the very
    // file it staged, or such a link with the export itself removed again.
    const outFile = path.join(resultsDir, `${FILE_ID}.jsonl`);
    const takeVacatedName = [
      (staging: string) => fs.writeFileSync(staging, 'NOT OURS'),
      (staging: string) => fs.linkSync(outFile, staging),
      (staging: string) => { fs.linkSync(outFile, staging); fs.unlinkSync(outFile); },
    ];
    // Windows has no directory fsync; inject after its actual commit boundary.
    const failurePoints = process.platform === 'win32' ? ['rename'] as const : ['rename', 'directory fsync'] as const;
    for (const failAt of failurePoints) {
      for (const take of takeVacatedName) {
        fs.rmSync(resultsDir, { recursive: true, force: true });
        mockShortId.mockImplementationOnce(() => FILE_ID);
        serveTwoPages();
        let staging: string | undefined;
        const restore = _setAtomicWriteAuditHook((event) => {
          if (event.kind === 'rename') staging = event.from;
          const hit = failAt === 'rename'
            ? event.kind === 'rename'
            : staging !== undefined && event.kind === 'fsync' && fs.fstatSync(event.fd).isDirectory();
          if (!hit) return;
          expect(fs.existsSync(staging!)).toBe(false); // the rename has happened
          take(staging!);
          throw new Error(`injected ${failAt} failure`);
        });
        try {
          await expect(exportAll()).rejects.toThrow(`injected ${failAt} failure`);
        } finally {
          restore();
        }

        expect(fs.readdirSync(resultsDir).filter((name) => name.endsWith('.tmp'))).toEqual([path.basename(staging!)]);
      }
    }
  });
});
