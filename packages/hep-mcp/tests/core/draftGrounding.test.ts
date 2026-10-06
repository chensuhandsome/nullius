import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleToolCall } from '../../src/tools/index.js';
import { readHepUri } from '../../src/core/uriReader.js';

let dataDir: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.HEP_DATA_DIR;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-grounding-'));
  process.env.HEP_DATA_DIR = dataDir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.HEP_DATA_DIR;
  else process.env.HEP_DATA_DIR = previous;
  fs.rmSync(dataDir, { recursive: true, force: true });
});
async function newRun(): Promise<string> {
  const project = JSON.parse((await handleToolCall('hep_project_create', { name: 'Draft input' })).content[0]!.text) as { project_id: string };
  const session = await handleToolCall('hep_run_create', { project_id: project.project_id });
  expect(session.isError).not.toBe(true);
  return (JSON.parse(session.content[0]!.text) as { run_id: string }).run_id;
}
function readArtifact(runId: string, name: string): Record<string, unknown> {
  const value = readHepUri(`hep://runs/${encodeURIComponent(runId)}/artifact/${name}`);
  if (!('text' in value)) throw new Error('Expected JSON text');
  return JSON.parse(value.text) as Record<string, unknown>;
}

describe('draft grounding metadata at the public renderer', () => {
  it('keeps omitted grounding unknown and preserves explicitly supplied true and false', async () => {
    const runId = await newRun();
    const result = await handleToolCall('hep_render_latex', {
      run_id: runId,
      draft: { version: 1, paragraphs: [{ sentences: [
        { sentence: 'Unchecked draft assertion.', type: 'fact' },
        { sentence: 'Caller marks this ungrounded.', is_grounded: false },
        { sentence: 'Caller asserts prior grounding.', is_grounded: true },
      ] }] },
    });
    expect(result.isError).not.toBe(true);
    const section = readArtifact(runId, 'rendered_section_output.json');
    const attrs = section.attributions as Array<Record<string, unknown>>;
    expect(attrs).toHaveLength(3);
    expect(attrs[0]).not.toHaveProperty('is_grounded');
    expect(attrs[1]?.is_grounded).toBe(false);
    expect(attrs[2]?.is_grounded).toBe(true);
    expect(attrs[0]?.citations).toEqual([]);
    expect(section.content).toContain('Unchecked draft assertion.');
    expect(section).not.toHaveProperty('verification');
    expect(fs.existsSync(path.join(dataDir, 'runs', runId, 'artifacts/rendered_latex_verification.json'))).toBe(false);
  });

  it('rejects a non-boolean grounding value before changing the manifest or writing rendered artifacts', async () => {
    const runId = await newRun();
    const manifestFile = path.join(dataDir, 'runs', runId, 'manifest.json');
    const before = fs.readFileSync(manifestFile);
    const result = await handleToolCall('hep_render_latex', {
      run_id: runId,
      draft: { paragraphs: [{ sentences: [{ sentence: 'Draft input.', is_grounded: 'true' }] }] },
    });
    expect(result.isError).toBe(true);
    expect(fs.readFileSync(manifestFile)).toEqual(before);
    expect(fs.existsSync(path.join(dataDir, 'runs', runId, 'artifacts/rendered_latex.tex'))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'runs', runId, 'artifacts/rendered_section_output.json'))).toBe(false);
  });
});
