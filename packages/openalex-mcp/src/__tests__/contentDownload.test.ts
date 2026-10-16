import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/rateLimiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/rateLimiter.js')>()),
  openalexFetchFullUrl: vi.fn(),
}));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return { ...actual, closeSync: vi.fn(actual.closeSync) };
});
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomBytes: vi.fn(actual.randomBytes) };
});

import { randomBytes } from 'crypto';
import { _setAtomicWriteAuditHook } from '@nullius/shared';
import { handleContent } from '../api/contentDownload.js';
import { openalexFetchFullUrl } from '../api/rateLimiter.js';

const mockFetch = vi.mocked(openalexFetchFullUrl);
const mockRandomBytes = vi.mocked(randomBytes);
const mockClose = vi.mocked(fs.closeSync);
const { closeSync: actualCloseSync } = await vi.importActual<typeof import('fs')>('fs');
const ORIGINAL_OPENALEX_DATA_DIR = process.env.OPENALEX_DATA_DIR;
const PDF_BYTES = Buffer.from('%PDF-1.4 test body');

function plantFileLink(target: string, entry: string): void {
  if (process.platform === 'win32') fs.linkSync(target, entry);
  else fs.symlinkSync(target, entry);
}

function expectFileLink(entry: string, target: string): void {
  if (process.platform === 'win32') expect(fs.statSync(entry).ino).toBe(fs.statSync(target).ino);
  else expect(fs.readlinkSync(entry)).toBe(target);
}

// The next closeSync really closes its descriptor and then reports failure.
function failNextClose(): void {
  mockClose.mockImplementationOnce((fd: number) => {
    actualCloseSync(fd);
    throw Object.assign(new Error('injected close failure'), { code: 'EIO' });
  });
}

function download(outDir?: string) {
  return handleContent({ work_id: 'W123', type: 'pdf', out_dir: outDir, _confirm: true, max_size_mb: 1 });
}

describe('handleContent out_dir containment', () => {
  let dataDir: string;
  let outside: string;

  beforeEach(() => {
    // Real paths, so the data dir itself is not reached through an alias.
    dataDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-content-data-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-content-outside-')));
    process.env.OPENALEX_DATA_DIR = dataDir;
    mockFetch.mockReset();
    mockRandomBytes.mockReset(); // back to the real randomBytes
    mockClose.mockReset(); // back to the real closeSync
    mockFetch.mockImplementation(async () => new Response(PDF_BYTES, {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }));
  });

  afterEach(() => {
    if (ORIGINAL_OPENALEX_DATA_DIR === undefined) delete process.env.OPENALEX_DATA_DIR;
    else process.env.OPENALEX_DATA_DIR = ORIGINAL_OPENALEX_DATA_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('accepts an out_dir whose name begins with two dots inside the data dir', async () => {
    const outDir = path.join(dataDir, '..downloads');

    const result = await download(outDir);

    expect(result.file_path).toBe(path.join(outDir, 'W123.pdf'));
    expect(fs.readFileSync(result.file_path)).toEqual(PDF_BYTES);
  });

  it('accepts an out_dir under a symlink whose real target begins with two dots inside the data dir', async () => {
    // The spelled path passes the lexical test; the real location of the
    // deepest existing component is `<data>/..real`.
    fs.mkdirSync(path.join(dataDir, '..real'));
    fs.symlinkSync(path.join(dataDir, '..real'), path.join(dataDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const outDir = path.join(dataDir, 'link', 'sub');

    const result = await download(outDir);

    expect(result.file_path).toBe(path.join(outDir, 'W123.pdf'));
    expect(fs.readFileSync(path.join(dataDir, '..real', 'sub', 'W123.pdf'))).toEqual(PDF_BYTES);
  });

  it('still rejects an out_dir that leaves the data dir through the parent or a symlink', async () => {
    fs.symlinkSync(outside, path.join(dataDir, 'out-link'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(download(path.join(dataDir, '..', path.basename(outside)))).rejects.toThrow(/out_dir must be within/);
    await expect(download(path.join(dataDir, 'out-link', 'sub'))).rejects.toThrow(/symlink escape detected/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('accepts a repeated download into an out_dir reached through a link inside the data dir', async () => {
    // The second download finds W123.pdf already in place; its real location
    // is under <data>/real, the out_dir is spelled through <data>/link.
    fs.mkdirSync(path.join(dataDir, 'real'));
    fs.symlinkSync(path.join(dataDir, 'real'), path.join(dataDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    const outDir = path.join(dataDir, 'link', 'sub');

    await download(outDir);
    const second = await download(outDir);

    expect(second.file_path).toBe(path.join(outDir, 'W123.pdf'));
    expect(fs.readFileSync(path.join(dataDir, 'real', 'sub', 'W123.pdf'))).toEqual(PDF_BYTES);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('accepts repeated downloads when the data dir itself is reached through a link, and still refuses a link out', async () => {
    // An explicit alias, so this holds on hosts whose temp dir is not itself
    // a symlink (Linux) as well as under /var -> /private/var (macOS).
    const aliasHolder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'openalex-content-alias-')));
    try {
      const aliasData = path.join(aliasHolder, 'data');
      fs.symlinkSync(dataDir, aliasData, process.platform === 'win32' ? 'junction' : 'dir');
      process.env.OPENALEX_DATA_DIR = aliasData;
      const outDir = path.join(aliasData, 'sub');

      await download(outDir);
      const second = await download(outDir);
      await download();
      const secondDefault = await download();

      expect(second.file_path).toBe(path.join(outDir, 'W123.pdf'));
      expect(secondDefault.file_path).toBe(path.join(aliasData, 'content', 'W123.pdf'));
      expect(fs.readFileSync(path.join(dataDir, 'sub', 'W123.pdf'))).toEqual(PDF_BYTES);
      expect(fs.readFileSync(path.join(dataDir, 'content', 'W123.pdf'))).toEqual(PDF_BYTES);

      fs.symlinkSync(outside, path.join(dataDir, 'out-link'), process.platform === 'win32' ? 'junction' : 'dir');
      await expect(download(path.join(aliasData, 'out-link', 'sub'))).rejects.toThrow(/symlink escape detected/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(aliasHolder, { recursive: true, force: true });
    }
  });

  it('does not write through a link left at the old fixed staging name', async () => {
    const outDir = path.join(dataDir, 'sub');
    fs.mkdirSync(outDir);
    const victim = path.join(outside, 'victim.pdf');
    fs.writeFileSync(victim, 'ORIGINAL');
    plantFileLink(victim, path.join(outDir, 'W123.pdf.tmp'));

    const result = await download(outDir);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.lstatSync(result.file_path).isFile()).toBe(true);
    expect(fs.readFileSync(result.file_path)).toEqual(PDF_BYTES);
    expectFileLink(path.join(outDir, 'W123.pdf.tmp'), victim);
  });

  it('refuses to stage through an entry already present at the fresh staging name', async () => {
    // Force the staging name, then plant a link there: the exclusive create
    // must fail instead of following the link out of the data dir.
    const outDir = path.join(dataDir, 'sub');
    fs.mkdirSync(outDir);
    const victim = path.join(outside, 'victim.pdf');
    fs.writeFileSync(victim, 'ORIGINAL');
    const fixed = Buffer.alloc(8, 0xab);
    mockRandomBytes.mockImplementationOnce(() => fixed);
    const staging = path.join(outDir, `W123.pdf.${process.pid}.${fixed.toString('hex')}.tmp`);
    plantFileLink(victim, staging);

    await expect(download(outDir)).rejects.toThrow(/EEXIST/);

    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expectFileLink(staging, victim);
    expect(fs.existsSync(path.join(outDir, 'W123.pdf'))).toBe(false);
  });
  it('refuses a default content dir that is a link out of the data dir', async () => {
    fs.symlinkSync(outside, path.join(dataDir, 'content'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(download()).rejects.toThrow(/content dir: symlink escape detected/);

    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('removes its staging file when the final rename fails', async () => {
    // A directory at the destination makes the rename fail after the whole
    // body has been staged.
    const outDir = path.join(dataDir, 'sub');
    fs.mkdirSync(path.join(outDir, 'W123.pdf'), { recursive: true });

    await expect(download(outDir)).rejects.toThrow(/rename/);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(fs.readdirSync(outDir)).toEqual(['W123.pdf']);
    expect(fs.statSync(path.join(outDir, 'W123.pdf')).isDirectory()).toBe(true);
  });
  it('leaves whatever takes the vacated staging name after a completed rename', async () => {
    // The rename succeeds and a later step then fails (the audit record of the
    // rename, or the directory fsync); by then the vacated staging name holds
    // an entry this download did not create: another file, a link to the very
    // file it staged, or such a link with the destination itself removed again.
    const outDir = path.join(dataDir, 'sub');
    const destPath = path.join(outDir, 'W123.pdf');
    const takeVacatedName = [
      (staging: string) => fs.writeFileSync(staging, 'NOT OURS'),
      (staging: string) => fs.linkSync(destPath, staging),
      (staging: string) => { fs.linkSync(destPath, staging); fs.unlinkSync(destPath); },
    ];
    const failurePoints = process.platform === 'win32' ? ['rename'] as const : ['rename', 'directory fsync'] as const;
    for (const failAt of failurePoints) {
      for (const take of takeVacatedName) {
        fs.rmSync(outDir, { recursive: true, force: true });
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
          await expect(download(outDir)).rejects.toThrow(`injected ${failAt} failure`);
        } finally {
          restore();
        }

        expect(fs.readdirSync(outDir).filter((name) => name.endsWith('.tmp'))).toEqual([path.basename(staging!)]);
      }
    }
  });

  it('removes its staging file when the body exceeds max_size_mb', async () => {
    const outDir = path.join(dataDir, 'sub');
    mockFetch.mockImplementation(async () => new Response(Buffer.alloc(1024 * 1024 + 1), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }));

    await expect(download(outDir)).rejects.toThrow(/exceeded max_size_mb/);

    expect(fs.readdirSync(outDir)).toEqual([]);
  });
  it('removes its staging file when closing it fails, after a failed or a complete download', async () => {
    const outDir = path.join(dataDir, 'sub');
    mockFetch.mockImplementationOnce(async () => {
      failNextClose();
      return new Response(Buffer.alloc(1024 * 1024 + 1), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });

    await expect(download(outDir)).rejects.toThrow(/exceeded max_size_mb/);

    expect(fs.readdirSync(outDir)).toEqual([]);

    failNextClose();

    await expect(download(outDir)).rejects.toThrow(/injected close failure/);

    expect(fs.readdirSync(outDir)).toEqual([]);
  });

  it('leaves an entry that replaced its staging file before the download failed', async () => {
    // While the body streams, the staging name is taken over by another file;
    // the over-size failure that follows must not remove that file.
    const outDir = path.join(dataDir, 'sub');
    mockFetch.mockImplementation(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        const [name] = fs.readdirSync(outDir).filter((entry) => entry.endsWith('.tmp'));
        fs.unlinkSync(path.join(outDir, name));
        fs.writeFileSync(path.join(outDir, name), 'NOT OURS');
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    }, { highWaterMark: 0 }), {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
    }));

    await expect(download(outDir)).rejects.toThrow(/exceeded max_size_mb/);

    const staging = fs.readdirSync(outDir).filter((name) => name.endsWith('.tmp'));
    expect(staging).toHaveLength(1);
    expect(fs.readFileSync(path.join(outDir, staging[0]), 'utf-8')).toBe('NOT OURS');
  });
});
