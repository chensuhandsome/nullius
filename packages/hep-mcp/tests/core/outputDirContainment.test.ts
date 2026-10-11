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
