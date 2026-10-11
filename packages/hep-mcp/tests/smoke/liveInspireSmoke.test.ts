import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { handleToolCall } from '../../src/tools/index.js';
import { makeProjectRoot, readProjectFile } from '../support/hepProjectUri.js';

const LIVE_SMOKE_ENABLED = process.env.HEP_LIVE_SMOKE === '1';
const describeLive = LIVE_SMOKE_ENABLED ? describe : describe.skip;

describeLive('R8 live smoke: INSPIRE corpus (optional)', () => {
  let dataDir: string;
  let originalDataDirEnv: string | undefined;

  beforeEach(() => {
    originalDataDirEnv = process.env.HEP_DATA_DIR;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hep-data-'));
    process.env.HEP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDirEnv !== undefined) {
      process.env.HEP_DATA_DIR = originalDataDirEnv;
    } else {
      delete process.env.HEP_DATA_DIR;
    }
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it(
    'resolves a small real corpus to recids and writes evidence-first artifacts',
    async () => {
      const projectRoot = makeProjectRoot(dataDir);

      const identifiers = ['1238419', '1258603'];
      const res = await handleToolCall('hep_inspire_resolve_identifiers', {
        project_root: projectRoot,
        output_dir: 'smoke',
        identifiers,
      });

      expect(res.isError).not.toBe(true);
      const payload = JSON.parse(res.content[0].text) as {
        mapping_path: string;
        summary: { total: number; matched: number; not_found: number; errors: number };
      };

      expect(payload.summary.total).toBe(2);
      expect(payload.summary.matched).toBe(2);
      expect(payload.summary.not_found).toBe(0);
      expect(payload.summary.errors).toBe(0);

      const mappingText = readProjectFile(projectRoot, payload.mapping_path);
      const lines = mappingText
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line)) as Array<{ input: string; status: string; recid?: string }>;

      const byInput = new Map(lines.map(l => [l.input, l]));
      for (const id of identifiers) {
        expect(byInput.get(id)?.status).toBe('matched');
        expect(byInput.get(id)?.recid).toBe(id);
      }
    },
    30_000
  );
});
