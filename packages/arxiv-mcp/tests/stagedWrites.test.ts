import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/api/rateLimiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/rateLimiter.js')>()),
  arxivFetch: vi.fn(),
}));
vi.mock('../src/source/tarExtractor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/source/tarExtractor.js')>();
  return { ...actual, isTarArchive: vi.fn(actual.isTarArchive) };
});

import { arxivFetch } from '../src/api/rateLimiter.js';
import { getPaperContent } from '../src/source/paperContent.js';
import { isTarArchive } from '../src/source/tarExtractor.js';

const mockFetch = vi.mocked(arxivFetch);
const mockIsTar = vi.mocked(isTarArchive);
const ARXIV_ID = '2301.12345';
const MAIN_TEX = '\\documentclass{article}\\begin{document}x\\end{document}\n';
const ORIGINAL_MAX_BYTES = process.env.ARXIV_MAX_DOWNLOAD_BYTES;

// arXiv answers the e-print HEAD as a single gz file and serves `body` for it;
// the PDF fallback is not available.
function serve(body: Buffer): void {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/pdf/')) return new Response('missing', { status: 404 });
    if (init?.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { 'content-type': 'application/x-eprint' } });
    }
    return new Response(body, { status: 200 });
  });
}

function tarGz(dir: string, name: string, content: string): Buffer {
  const src = fs.mkdtempSync(path.join(dir, 'tar-src-'));
  fs.writeFileSync(path.join(src, name), content);
  const tarPath = path.join(dir, 'bundle.tar');
  tar.c({ cwd: src, file: tarPath, sync: true, portable: true }, [name]);
  const bytes = zlib.gzipSync(fs.readFileSync(tarPath));
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(tarPath, { force: true });
  return bytes;
}

describe('arXiv source download and extraction stage their writes', () => {
  let base: string;
  let outside: string;
  let destDir: string;

  beforeEach(() => {
    base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-staged-')));
    outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'arxiv-staged-outside-')));
    destDir = path.join(base, `arxiv-${ARXIV_ID}`);
    fs.mkdirSync(destDir);
    mockFetch.mockReset();
    mockIsTar.mockReset(); // back to the real isTarArchive
  });

  afterEach(() => {
    if (ORIGINAL_MAX_BYTES === undefined) delete process.env.ARXIV_MAX_DOWNLOAD_BYTES;
    else process.env.ARXIV_MAX_DOWNLOAD_BYTES = ORIGINAL_MAX_BYTES;
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function leftovers(): string[] {
    return fs.readdirSync(destDir).filter(name => name.startsWith('extracted_content') || name.includes('.tmp.'));
  }

  it('does not write through links at the old fixed decompression name or at the download target', async () => {
    const victim = path.join(outside, 'victim.txt');
    const victimArchive = path.join(outside, 'victim.tar.gz');
    fs.writeFileSync(victim, 'ORIGINAL');
    fs.writeFileSync(victimArchive, 'ORIGINAL');
    const plantLink = process.platform === 'win32' ? fs.linkSync : fs.symlinkSync;
    plantLink(victim, path.join(destDir, 'extracted_content'));
    plantLink(victimArchive, path.join(destDir, 'source.tar.gz'));
    serve(zlib.gzipSync(MAIN_TEX));

    const result = await getPaperContent({ identifier: ARXIV_ID, output_dir: base, prefer: 'latex' });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('ORIGINAL');
    expect(fs.readFileSync(victimArchive, 'utf-8')).toBe('ORIGINAL');
    expect(fs.lstatSync(path.join(destDir, 'main.tex')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'main.tex'), 'utf-8')).toBe(MAIN_TEX);
    expect(fs.lstatSync(path.join(destDir, 'source.tar.gz')).isFile()).toBe(true);
    if (process.platform === 'win32') {
      expect(fs.statSync(path.join(destDir, 'extracted_content')).ino).toBe(fs.statSync(victim).ino);
    } else {
      expect(fs.readlinkSync(path.join(destDir, 'extracted_content'))).toBe(victim);
    }
  });

  it('keeps the previous download and leaves no staging file when a download is aborted', async () => {
    fs.writeFileSync(path.join(destDir, 'source.tar.gz'), 'previous');
    process.env.ARXIV_MAX_DOWNLOAD_BYTES = '16';
    serve(Buffer.alloc(64, 1));

    const result = await getPaperContent({ identifier: ARXIV_ID, output_dir: base, prefer: 'latex' });

    expect(result.success).toBe(false);
    expect(fs.readFileSync(path.join(destDir, 'source.tar.gz'), 'utf-8')).toBe('previous');
    expect(fs.readdirSync(destDir)).toEqual(['source.tar.gz']);
  });

  it('removes the decompressed file after unpacking a tar, but not an entry that replaced it', async () => {
    serve(tarGz(base, 'paper.tex', MAIN_TEX));

    const first = await getPaperContent({ identifier: ARXIV_ID, output_dir: base, prefer: 'latex' });

    expect(first.success).toBe(true);
    expect(fs.readFileSync(path.join(destDir, 'paper.tex'), 'utf-8')).toBe(MAIN_TEX);
    expect(leftovers()).toEqual([]);

    // While the archive is inspected, another file (renamed over it, so it
    // holds a different inode) takes the decompressed file's name.
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.mkdirSync(destDir);
    mockIsTar.mockImplementationOnce(async (filePath: string) => {
      const foreign = path.join(destDir, 'foreign');
      fs.copyFileSync(filePath, foreign);
      fs.renameSync(foreign, filePath);
      return true;
    });

    const second = await getPaperContent({ identifier: ARXIV_ID, output_dir: base, prefer: 'latex' });

    expect(second.success).toBe(true);
    expect(leftovers()).toHaveLength(1);
  });

  it('removes the decompressed file when it cannot be renamed to main.tex', async () => {
    // A non-empty directory appears at main.tex after the cache check, so the
    // final rename fails.
    mockIsTar.mockImplementationOnce(async () => {
      fs.mkdirSync(path.join(destDir, 'main.tex', 'inner'), { recursive: true });
      return false;
    });
    serve(zlib.gzipSync(MAIN_TEX));

    const result = await getPaperContent({ identifier: ARXIV_ID, output_dir: base, prefer: 'latex' });

    expect(result.success).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(fs.statSync(path.join(destDir, 'main.tex')).isDirectory()).toBe(true);
  });
});
