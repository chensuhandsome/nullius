import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/api/client.js', () => ({
  search: vi.fn(),
  searchByUrl: vi.fn(),
  getPaper: vi.fn(),
  getByDoi: vi.fn(),
  getByArxiv: vi.fn(),
}));

const api = await import('../../src/api/client.js');
const { handleToolCall } = await import('../../src/tools/index.js');
const { makeProjectRoot } = await import('../support/hepProjectUri.js');
const { withHepDataRoot } = await import('../../src/data/dataDir.js');
const { openOutputStream, resolveOutputDir, writeOutputJson } = await import('../../src/core/outputDir.js');
const { upstreamError } = await import('@nullius/shared');

type ToolResult = Awaited<ReturnType<typeof handleToolCall>>;

function errorOf(result: ToolResult): { code: string; message: string } {
  expect(result.isError).toBe(true);
  return (JSON.parse(result.content[0]!.text) as { error: { code: string; message: string } }).error;
}

/**
 * Every case names the project through an explicit symlinked alias, so the
 * alias-versus-canonical distinction is exercised on every platform (on
 * macOS the temp directory is itself an alias of /private/var, on Linux it
 * is not).
 */
describe('output_dir lies inside the admitted project root, through real directories only', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  async function resolveIds(args: Record<string, unknown>): Promise<ToolResult> {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    return handleToolCall('hep_inspire_resolve_identifiers', { identifiers: ['123'], ...args });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts a root named through an alias above it and writes under the canonical root', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: path.join(alias, 'out', 'ids') });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { output_dir: string; mapping_path: string };
    expect(payload.output_dir).toBe('out/ids');
    expect(fs.existsSync(path.join(projectRoot, payload.mapping_path))).toBe(true);
    expect(fs.lstatSync(path.join(projectRoot, 'out')).isDirectory()).toBe(true);
  });

  it('accepts an absolute output_dir spelled through the alias when the root is given canonically', async () => {
    const result = await resolveIds({ project_root: projectRoot, output_dir: path.join(alias, 'notes') });
    expect(result.isError).toBeFalsy();
    expect((JSON.parse(result.content[0]!.text) as { output_dir: string }).output_dir).toBe('notes');
    expect(fs.readdirSync(path.join(projectRoot, 'notes')).some(name => name.endsWith('.jsonl'))).toBe(true);
  });

  it('refuses a relative output_dir that leaves the root, and creates nothing outside', async () => {
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: '../outside' }));
    expect(error.message).toMatch(/inside project_root/);
    expect(fs.existsSync(path.join(tmpDir, 'outside'))).toBe(false);
  });

  it('refuses an absolute output_dir outside the root', async () => {
    const outside = path.join(tmpDir, 'elsewhere');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: outside }));
    expect(error.message).toMatch(/inside project_root/);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('refuses a symlink below the root even when it points inside the project', async () => {
    fs.mkdirSync(path.join(projectRoot, 'real'));
    fs.symlinkSync(path.join(projectRoot, 'real'), path.join(projectRoot, 'linked'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'linked/sub' }));
    expect(error.code).toBe('UNSAFE_FS');
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.existsSync(path.join(projectRoot, 'real', 'sub'))).toBe(false);
  });

  it('refuses a symlink below the root that leads outside, and writes nothing there', async () => {
    const elsewhere = path.join(tmpDir, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, path.join(projectRoot, 'escape'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: path.join(alias, 'escape', 'sub') }));
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses a dangling symlink below the root instead of creating its target', async () => {
    const missing = path.join(tmpDir, 'missing');
    fs.symlinkSync(missing, path.join(projectRoot, 'dangling'), 'dir');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'dangling' }));
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses a file where a directory is needed', async () => {
    fs.writeFileSync(path.join(projectRoot, 'notes.txt'), 'x');
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: 'notes.txt/sub' }));
    expect(error.message).toMatch(/must name a directory/);
  });

  it.each([
    '.nullius/out',
    'team/runs/r1',
    'artifacts/hep-mcp/runs/run_x',
    'artifacts/hep-mcp',
    'Artifacts/HEP-MCP/x',
  ])('refuses the reserved location %s', async outputDir => {
    const error = errorOf(await resolveIds({ project_root: alias, output_dir: outputDir }));
    expect(error.message).toMatch(/must not lie under/);
  });

  it('accepts a sibling whose name only begins like a reserved directory', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: 'artifacts/hep-mcp-notes' });
    expect(result.isError).toBeFalsy();
  });

  it.each(['.', ''])('refuses the project root itself or a blank output_dir (%j)', async outputDir => {
    const result = await resolveIds({ project_root: alias, output_dir: outputDir });
    expect(result.isError).toBe(true);
  });

  it('refuses the project root itself spelled through the alias', async () => {
    const error = errorOf(await resolveIds({ project_root: projectRoot, output_dir: alias }));
    expect(error.message).toMatch(/not the root itself/);
  });

  it('requires project_root', async () => {
    const error = errorOf(await resolveIds({ output_dir: 'out' }));
    expect(error.message).toMatch(/output_dir requires project_root/);
  });

  it('refuses to write through a symlink planted at the output file, leaving its target untouched', async () => {
    const victim = path.join(tmpDir, 'victim.jsonl');
    fs.writeFileSync(victim, 'original\n');
    fs.mkdirSync(path.join(projectRoot, 'out'));
    fs.symlinkSync(victim, path.join(projectRoot, 'out', 'map.jsonl'), 'file');
    const error = errorOf(await resolveIds({
      project_root: alias,
      output_dir: 'out',
      artifact_name: 'map.jsonl',
      meta_artifact_name: 'map_meta.json',
    }));
    expect(error.message).toMatch(/symbolic link/);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original\n');
  });

  it('records each external API call under external_api/ in the output directory', async () => {
    const result = await resolveIds({ project_root: alias, output_dir: 'out' });
    expect(result.isError).toBeFalsy();
    const records = fs.readdirSync(path.join(projectRoot, 'out', 'external_api')).sort();
    expect(records.some(name => name.startsWith('external_api_request_inspire_getPaper_'))).toBe(true);
    expect(records.some(name => name.startsWith('external_api_response_inspire_getPaper_'))).toBe(true);
  });
});

describe('output files are checked again at write time and streamed outputs fail cleanly', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-write-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function temporaryFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));
  }

  it('refuses a write after the admitted directory was swapped for a symlink', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('out/sub');
      fs.renameSync(path.join(projectRoot, 'out'), path.join(tmpDir, 'moved-away'));
      fs.symlinkSync(outside, path.join(projectRoot, 'out'), 'dir');
      expect(() => writeOutputJson(out, 'late.json', { x: 1 })).toThrow(/symbolic link/);
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('holds an error raised while opening the stream until commit, with no crash and no residue', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('locked');
      fs.chmodSync(out.dir, 0o555);
      try {
        const file = openOutputStream(out, 'records.jsonl');
        file.stream.write('{"a":1}\n');
        await new Promise(resolve => setTimeout(resolve, 50));
        await expect(file.commit()).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        fs.chmodSync(out.dir, 0o755);
      }
      expect(temporaryFiles(out.dir)).toEqual([]);
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
    });
  });

  it('rejects commit and removes the temporary file when a write fails midway', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('midway');
      const file = openOutputStream(out, 'records.jsonl');
      file.stream.write('{"a":1}\n');
      file.stream.destroy(new Error('simulated disk full'));
      await expect(file.commit()).rejects.toThrow('simulated disk full');
      expect(temporaryFiles(out.dir)).toEqual([]);
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
    });
  });

  it('rejects commit and removes the temporary file when the target became a directory', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('final');
      const file = openOutputStream(out, 'records.jsonl');
      file.stream.write('{"a":1}\n');
      fs.mkdirSync(path.join(out.dir, 'records.jsonl'));
      await expect(file.commit()).rejects.toThrow(/non-file entry/);
      expect(temporaryFiles(out.dir)).toEqual([]);
    });
  });

  it('refuses a write when the directory is swapped while the data is being serialized', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('serial');
      const data = {
        toJSON: () => {
          fs.renameSync(path.join(projectRoot, 'serial'), path.join(tmpDir, 'serial-moved'));
          fs.symlinkSync(outside, path.join(projectRoot, 'serial'), 'dir');
          return { x: 1 };
        },
      };
      expect(() => writeOutputJson(out, 'late.json', data)).toThrow(/symbolic link/);
    });
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('does not delete through a swapped directory when a streamed commit fails', async () => {
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(outside);
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('swap');
      const file = openOutputStream(out, 'records.jsonl');
      file.stream.write('{"a":1}\n');
      await new Promise(resolve => file.stream.once('ready', resolve));
      const temp = temporaryFiles(out.dir)[0]!;
      const moved = path.join(tmpDir, 'swap-moved');
      fs.renameSync(out.dir, moved);
      fs.symlinkSync(outside, out.dir, 'dir');
      fs.writeFileSync(path.join(outside, temp), 'sentinel');
      await expect(file.commit()).rejects.toThrow(/symbolic link/);
      // The same-named file behind the symlink is untouched; the real
      // temporary file stays where it was created.
      expect(fs.readFileSync(path.join(outside, temp), 'utf-8')).toBe('sentinel');
      expect(fs.existsSync(path.join(moved, temp))).toBe(true);
      expect(fs.existsSync(path.join(outside, 'records.jsonl'))).toBe(false);
    });
  });

  it('never commits or deletes a same-named file in a real directory that replaced the output directory', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('replaced');
      const file = openOutputStream(out, 'records.jsonl');
      file.stream.write('{"genuine":true}\n');
      await new Promise(resolve => file.stream.once('ready', resolve));
      const temp = temporaryFiles(out.dir)[0]!;
      const moved = path.join(tmpDir, 'replaced-moved');
      fs.renameSync(out.dir, moved);
      fs.mkdirSync(out.dir);
      fs.writeFileSync(path.join(out.dir, temp), '{"stale":true}\n');
      await expect(file.commit()).rejects.toThrow(/replaced or is unknown/);
      expect(fs.existsSync(path.join(out.dir, 'records.jsonl'))).toBe(false);
      expect(fs.readFileSync(path.join(out.dir, temp), 'utf-8')).toBe('{"stale":true}\n');
      expect(fs.existsSync(path.join(moved, temp))).toBe(true);
    });
  });

  it('leaves no temporary file when aborted before the file was opened', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('early');
      const file = openOutputStream(out, 'records.jsonl');
      file.abort();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(temporaryFiles(out.dir)).toEqual([]);
    });
  });

  it('commits a streamed file in place of the target and leaves no temporary file', async () => {
    await withHepDataRoot(alias, async () => {
      const out = resolveOutputDir('ok');
      const file = openOutputStream(out, 'records.jsonl');
      file.stream.write('{"a":1}\n');
      await file.commit();
      expect(fs.readFileSync(path.join(out.dir, 'records.jsonl'), 'utf-8')).toBe('{"a":1}\n');
      expect(temporaryFiles(out.dir)).toEqual([]);
    });
  });
});

describe('identifier resolution does not turn a refused write into a per-identifier failure', () => {
  let tmpDir: string;
  let projectRoot: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-ids-')));
    projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('fails the call when an external API record path is a planted symlink', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const first = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(first.isError).toBeFalsy();
    const recordDir = path.join(projectRoot, 'ids', 'external_api');
    const request = fs.readdirSync(recordDir).find(name => name.startsWith('external_api_request_inspire_getPaper_'))!;
    const victim = path.join(tmpDir, 'victim.json');
    fs.writeFileSync(victim, 'original');
    fs.rmSync(path.join(recordDir, request));
    fs.symlinkSync(victim, path.join(recordDir, request), 'file');

    const second = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(errorOf(second).code).toBe('UNSAFE_FS');
    expect(fs.readFileSync(victim, 'utf-8')).toBe('original');
  });

  it('fails the call when a cached response is malformed', async () => {
    vi.mocked(api.getPaper).mockResolvedValue({ recid: '123' } as any);
    const first = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(first.isError).toBeFalsy();
    const cacheRoot = path.join(projectRoot, 'artifacts', 'hep-mcp', 'cache', 'external_api_v1', 'inspire', 'getPaper');
    const shard = fs.readdirSync(cacheRoot)[0]!;
    const entryPath = path.join(cacheRoot, shard, fs.readdirSync(path.join(cacheRoot, shard))[0]!);
    const entry = JSON.parse(fs.readFileSync(entryPath, 'utf-8')) as Record<string, unknown>;
    fs.writeFileSync(entryPath, JSON.stringify({ ...entry, response: null }));

    const second = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(errorOf(second).message).toMatch(/non-object response/);
  });

  it('fails the call when INSPIRE returns something that is not a record', async () => {
    vi.mocked(api.getPaper).mockResolvedValue(null as any);
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(errorOf(result).message).toMatch(/non-object response/);
  });

  it('reports a network failure of the lookup per identifier', async () => {
    vi.mocked(api.getPaper).mockRejectedValue(new TypeError('fetch failed'));
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0]!.text) as { summary: { errors: number }; mapping_path: string };
    expect(payload.summary.errors).toBe(1);
  });

  it('still reports an INSPIRE lookup failure per identifier', async () => {
    vi.mocked(api.getPaper).mockRejectedValue(upstreamError('INSPIRE API error: 503', { status: 503 }));
    const result = await handleToolCall('hep_inspire_resolve_identifiers', { project_root: alias, output_dir: 'ids', identifiers: ['123'] });
    expect(result.isError).toBeFalsy();
    expect((JSON.parse(result.content[0]!.text) as { summary: { errors: number } }).summary.errors).toBe(1);
  });
});

describe('a search export aborts on a malformed search page', () => {
  it('refuses a non-page INSPIRE response with INVALID_PARAMS and commits no export', async () => {
    vi.resetAllMocks();
    const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-page-')));
    try {
      const projectRoot = makeProjectRoot(tmpDir);
      const alias = path.join(tmpDir, 'alias');
      fs.symlinkSync(projectRoot, alias, 'dir');
      vi.mocked(api.search).mockResolvedValueOnce(null as any);
      const result = await handleToolCall('hep_inspire_search_export', { project_root: alias, output_dir: 'out', query: 't:x' });
      const error = errorOf(result);
      expect(error.code).toBe('INVALID_PARAMS');
      expect(error.message).toMatch(/malformed search page/);
      expect(fs.readdirSync(path.join(projectRoot, 'out')).filter(name => name.endsWith('.jsonl') || name.endsWith('.tmp'))).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('inspire_search export mode refuses parameters that do not apply', () => {
  let tmpDir: string;
  let alias: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-outdir-search-')));
    const projectRoot = makeProjectRoot(tmpDir);
    alias = path.join(tmpDir, 'alias');
    fs.symlinkSync(projectRoot, alias, 'dir');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each([
    [{ page: 2 }, 'page'],
    [{ review_mode: 'exclude' }, 'review_mode'],
    [{ format: 'markdown' }, 'format'],
  ])('refuses %j with output_dir', async (extra, key) => {
    const result = await handleToolCall('inspire_search', { project_root: alias, output_dir: 'out', query: 't:x', ...extra });
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(JSON.stringify(result.content[0]!.text)).toContain(key);
    expect(api.search).not.toHaveBeenCalled();
  });

  it.each([
    [{ output_format: 'json' }, 'output_format'],
    [{ artifact_name: 'a.jsonl' }, 'artifact_name'],
    [{ meta_artifact_name: 'm.json' }, 'meta_artifact_name'],
  ])('refuses the export-only %j without output_dir', async (extra, key) => {
    const result = await handleToolCall('inspire_search', { query: 't:x', ...extra });
    expect(errorOf(result).code).toBe('INVALID_PARAMS');
    expect(result.content[0]!.text).toContain(key);
    expect(api.search).not.toHaveBeenCalled();
  });

  it('accepts an explicit JSON format with output_dir', async () => {
    vi.mocked(api.search).mockResolvedValueOnce({ total: 0, papers: [], has_more: false } as any);
    const result = await handleToolCall('inspire_search', { project_root: alias, output_dir: 'out', query: 't:x', format: 'json' });
    expect(result.isError).toBeFalsy();
  });
});

describe('a run_id argument is refused rather than silently dropped', () => {
  it.each([
    ['inspire_search', { query: 't:x', run_id: 'run_abc' }],
    ['hep_project_query_evidence', { project_id: 'p1', query: 'x', run_id: 'run_abc' }],
    ['hep_inspire_search_export', { query: 't:x', run_id: 'run_abc' }],
    // A destructive tool reports the run_id refusal, not a confirmation request.
    ['hepdata_download', { hepdata_id: 1, run_id: 'run_abc' }],
  ])('%s with run_id', async (tool, args) => {
    vi.resetAllMocks();
    const result = await handleToolCall(tool, args);
    const error = errorOf(result);
    expect(error.code).toBe('INVALID_PARAMS');
    expect(error.message).toMatch(/run_id is not accepted/);
    expect(api.search).not.toHaveBeenCalled();
  });
});
