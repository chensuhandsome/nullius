import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleToolCall } from '../../src/tools/index.js';
import { readHepUri } from '../../src/core/uriReader.js';

let dataDir: string;
let originalDataDir: string | undefined;
beforeEach(() => {
  originalDataDir = process.env.HEP_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-artifact-session-'));
  process.env.HEP_DATA_DIR = dataDir;
});
afterEach(() => {
  if (originalDataDir === undefined) delete process.env.HEP_DATA_DIR;
  else process.env.HEP_DATA_DIR = originalDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await handleToolCall(name, args);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0]!.text) as T;
}
function uriJson<T>(uri: string): T {
  const contents = readHepUri(uri);
  expect('text' in contents).toBe(true);
  if (!('text' in contents)) throw new Error('Expected a text artifact');
  return JSON.parse(contents.text) as T;
}
type Project = { project_id: string; uri: string };
type ArtifactRef = { name: string; uri: string };
type Session = { run_id: string; project_id: string; manifest_uri: string; artifacts: ArtifactRef[] };
type Manifest = { run_id: string; project_id: string; status: string; args_snapshot: ArtifactRef; steps: Array<{ step: string; status: string }> };

describe('provider artifact sessions', () => {
  it('keeps project, manifest and caller-argument artifact cross references at the live API', async () => {
    const project = await call<Project>('hep_project_create', { name: 'Explicit artifact catalog', description: 'Locally stored inputs' });
    const input = { source: 'domain-input', handoff_uri: 'file:///explicit-input.json', run_label: 'catalog-entry' };
    const session = await call<Session>('hep_run_create', { project_id: project.project_id, args_snapshot: input });
    expect(session.run_id.length).toBeGreaterThan(0);
    expect(session.project_id).toBe(project.project_id);
    expect((await call<{ project_id: string }>('hep_project_get', { project_id: project.project_id })).project_id).toBe(project.project_id);
    const catalog = await call<{ total: number; projects: Array<{ project_id: string }> }>('hep_project_list', {});
    expect(catalog.total).toBe(1);
    expect(catalog.projects.map(p => p.project_id)).toEqual([project.project_id]);
    expect(session.manifest_uri).toBe(`hep://runs/${encodeURIComponent(session.run_id)}/manifest`);
    expect(fs.existsSync(path.join(dataDir, 'runs', session.run_id, 'manifest.json'))).toBe(true);
    const manifest = uriJson<Manifest>(session.manifest_uri);
    expect(manifest).toMatchObject({ run_id: session.run_id, project_id: project.project_id, status: 'pending' });
    expect(manifest.steps).toEqual([expect.objectContaining({ step: 'run_create', status: 'done' })]);
    expect(manifest.args_snapshot.uri).toBe(`hep://runs/${encodeURIComponent(session.run_id)}/artifact/args_snapshot.json`);
    expect(session.artifacts).toContainEqual(manifest.args_snapshot);
    const snapshot = uriJson<{ run_id: string; project_id: string; args_snapshot: unknown }>(manifest.args_snapshot.uri);
    expect(snapshot).toMatchObject({ run_id: session.run_id, project_id: project.project_id, args_snapshot: input });
    const chunk = await call<{ artifact_uri: string; chunk_base64: string; eof: boolean }>('hep_run_read_artifact_chunk', {
      run_id: session.run_id, artifact_name: 'args_snapshot.json', offset: 0, length: 4096,
    });
    expect(chunk.artifact_uri).toBe(manifest.args_snapshot.uri);
    expect(chunk.eof).toBe(true);
    expect(JSON.parse(Buffer.from(chunk.chunk_base64, 'base64').toString('utf8'))).toEqual(snapshot);
    const listed = uriJson<{ runs: Array<{ run_id: string; project_id: string; uri: string }> }>('hep://runs');
    expect(listed.runs).toContainEqual(expect.objectContaining({ run_id: session.run_id, project_id: project.project_id, uri: session.manifest_uri }));
    expect(fs.existsSync(path.join(dataDir, '.nullius'))).toBe(false);
  });

  it('reuses the requested project and reads an ordinary domain artifact through its HEP URI', async () => {
    const project = await call<Project>('hep_project_create', { name: 'Existing catalog' });
    const first = await call<Session>('hep_run_create', { project_id: project.project_id });
    const second = await call<Session>('hep_run_create', { project_id: project.project_id });
    expect(first.project_id).toBe(project.project_id);
    expect(second.project_id).toBe(project.project_id);
    expect(second.run_id).not.toBe(first.run_id);
    expect(fs.readdirSync(path.join(dataDir, 'projects'))).toEqual([project.project_id]);
    const handoff = { explicit_domain_input: true };
    fs.writeFileSync(path.join(dataDir, 'runs', first.run_id, 'artifacts', 'domain_input.json'), JSON.stringify(handoff));
    expect(uriJson(`hep://runs/${encodeURIComponent(first.run_id)}/artifact/domain_input.json`)).toEqual(handoff);
  });

  it('refuses a missing project before creating a run or manifest', async () => {
    fs.mkdirSync(path.join(dataDir, 'runs'));
    const result = await handleToolCall('hep_run_create', { project_id: 'missing-project' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not found/i);
    expect(fs.readdirSync(path.join(dataDir, 'runs'))).toEqual([]);
  });
});
