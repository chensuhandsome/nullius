import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const { makeProjectRoot, readProjectFile } = await import('../support/projectFiles.js');

describe('Open Roadmap R5: INSPIRE API export + mapping into the caller output_dir', () => {
  let tmpDir: string;
  let projectRoot: string;

  beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-r5-'));
    projectRoot = makeProjectRoot(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hep_inspire_search_export writes files into output_dir and returns project-relative paths + summary', async () => {
    const papers = [
      { recid: '1', title: 'T1', authors: [] },
      { recid: '2', title: 'T2', authors: [] },
      { recid: '3', title: 'T3', authors: [] },
    ];

    vi.mocked(api.search).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(0, 2),
      has_more: true,
      next_url: 'https://inspirehep.net/api/literature?q=x&size=2&page=2',
    } as any);

    vi.mocked(api.searchByUrl).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(2),
      has_more: false,
    } as any);

    const exportRes = await handleToolCall('hep_inspire_search_export', {
      project_root: projectRoot,
      output_dir: 'artifacts/runs/M1-search/inspire',
      query: 't:qcd',
      size: 2,
      max_results: 10,
      output_format: 'jsonl',
    });

    expect(exportRes.isError).toBeFalsy();
    const payload = JSON.parse(exportRes.content[0].text) as {
      output_dir: string;
      export_path: string;
      meta_path: string;
      artifacts: Array<{ name: string; path: string }>;
      summary: { total: number; exported: number; pages_fetched: number };
    };

    expect(payload.output_dir).toBe('artifacts/runs/M1-search/inspire');
    expect(payload.export_path).toMatch(/^artifacts\/runs\/M1-search\/inspire\/inspire_search_export_[0-9a-f]{16}\.jsonl$/);
    expect(payload.meta_path).toMatch(/^artifacts\/runs\/M1-search\/inspire\/inspire_search_export_[0-9a-f]{16}_meta\.json$/);
    expect(payload.summary.total).toBe(3);
    expect(payload.summary.exported).toBe(3);
    expect(payload.summary.pages_fetched).toBe(2);

    const lines = readProjectFile(projectRoot, payload.export_path).trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines).toEqual(papers);

    const meta = JSON.parse(readProjectFile(projectRoot, payload.meta_path)) as {
      exported: number; total: number; output_dir: string; artifacts: { export_path: string; diagnostics_path: string };
    };
    expect(meta.exported).toBe(3);
    expect(meta.total).toBe(3);
    expect(meta.output_dir).toBe(payload.output_dir);
    expect(meta.artifacts.export_path).toBe(payload.export_path);
    expect(JSON.parse(readProjectFile(projectRoot, meta.artifacts.diagnostics_path)).operation).toBe('inspire_search_export');

    // Every reported file exists where reported; the two API pages are recorded under external_api/.
    for (const artifact of payload.artifacts) {
      expect(fs.existsSync(path.join(projectRoot, artifact.path)), artifact.path).toBe(true);
    }
    const apiRecords = fs.readdirSync(path.join(projectRoot, payload.output_dir, 'external_api')).sort();
    expect(apiRecords.filter(name => name.startsWith('external_api_response_'))).toHaveLength(2);
    // No hep-mcp run state is created anywhere.
    expect(fs.existsSync(path.join(projectRoot, 'artifacts', 'hep-mcp', 'runs'))).toBe(false);
  });

  it('hep_inspire_resolve_identifiers writes mapping jsonl and summary into output_dir', async () => {
    vi.mocked(api.getPaper).mockResolvedValueOnce({ recid: '123' } as any);
    vi.mocked(api.getByDoi).mockResolvedValueOnce({ recid: '456' } as any);
    vi.mocked(api.getByArxiv).mockResolvedValueOnce({ recid: '789' } as any);

    const res = await handleToolCall('hep_inspire_resolve_identifiers', {
      project_root: projectRoot,
      output_dir: 'notes/ids',
      identifiers: ['123', '10.1000/xyz', 'arxiv:1207.7214', 'weird'],
    });

    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(res.content[0].text) as {
      mapping_path: string;
      meta_path: string;
      summary: { total: number; matched: number; not_found: number; errors: number };
    };

    expect(payload.summary).toMatchObject({ total: 4, matched: 3, not_found: 1, errors: 0 });
    expect(payload.mapping_path.startsWith('notes/ids/')).toBe(true);

    const lines = readProjectFile(projectRoot, payload.mapping_path).trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines.map((l: any) => l.status)).toEqual(['matched', 'matched', 'matched', 'not_found']);
    expect(lines.map((l: any) => l.recid)).toEqual(['123', '456', '789', undefined]);

    const meta = JSON.parse(readProjectFile(projectRoot, payload.meta_path)) as { matched: number; not_found: number; errors: number; total: number };
    expect(meta).toMatchObject({ total: 4, matched: 3, not_found: 1, errors: 0 });
  });

  it('inspire_search with output_dir exports like hep_inspire_search_export', async () => {
    const papers = [
      { recid: '11', title: 'U1', authors: [] },
      { recid: '22', title: 'U2', authors: [] },
      { recid: '33', title: 'U3', authors: [] },
    ];

    vi.mocked(api.search).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(0, 2),
      has_more: true,
      next_url: 'https://inspirehep.net/api/literature?q=merged&size=2&page=2',
    } as any);

    vi.mocked(api.searchByUrl).mockResolvedValueOnce({
      total: 3,
      papers: papers.slice(2),
      has_more: false,
    } as any);

    const exportRes = await handleToolCall('inspire_search', {
      project_root: projectRoot,
      output_dir: 'scratch/merged',
      query: 't:merged',
      size: 2,
      max_results: 10,
      output_format: 'jsonl',
    });

    expect(exportRes.isError).toBeFalsy();
    const payload = JSON.parse(exportRes.content[0].text) as {
      export_path: string;
      meta_path: string;
      summary: { total: number; exported: number; pages_fetched: number };
    };

    expect(payload.export_path.startsWith('scratch/merged/')).toBe(true);
    expect(payload.summary).toMatchObject({ total: 3, exported: 3, pages_fetched: 2 });

    const lines = readProjectFile(projectRoot, payload.export_path).trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines).toEqual(papers);
  });

});
