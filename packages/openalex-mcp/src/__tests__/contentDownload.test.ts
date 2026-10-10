import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/rateLimiter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/rateLimiter.js')>()),
  openalexFetchFullUrl: vi.fn(),
}));

import { handleContent } from '../api/contentDownload.js';
import { openalexFetchFullUrl } from '../api/rateLimiter.js';

const mockFetch = vi.mocked(openalexFetchFullUrl);
const ORIGINAL_OPENALEX_DATA_DIR = process.env.OPENALEX_DATA_DIR;
const PDF_BYTES = Buffer.from('%PDF-1.4 test body');

function download(outDir: string) {
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
    fs.symlinkSync(path.join(dataDir, '..real'), path.join(dataDir, 'link'), 'dir');
    const outDir = path.join(dataDir, 'link', 'sub');

    const result = await download(outDir);

    expect(result.file_path).toBe(path.join(outDir, 'W123.pdf'));
    expect(fs.readFileSync(path.join(dataDir, '..real', 'sub', 'W123.pdf'))).toEqual(PDF_BYTES);
  });

  it('still rejects an out_dir that leaves the data dir through the parent or a symlink', async () => {
    fs.symlinkSync(outside, path.join(dataDir, 'out-link'), 'dir');

    await expect(download(path.join(dataDir, '..', path.basename(outside)))).rejects.toThrow(/out_dir must be within/);
    await expect(download(path.join(dataDir, 'out-link', 'sub'))).rejects.toThrow(/symlink escape detected/);
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
