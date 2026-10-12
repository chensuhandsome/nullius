import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { handleToolCall } from '../../src/tools/index.js';
import { resolvePathWithinParent } from '../../src/data/pathGuard.js';

// Every alias here is an explicit symlink built by the test, so the cases
// discriminate on hosts whose temp directory is not itself reached through
// an alias (Linux CI), as well as on macOS.

const ENV_KEYS = ['HEP_DATA_DIR', 'PDG_DATA_DIR', 'HEP_DOWNLOAD_DIR', 'ARXIV_DOWNLOAD_DIR'];

function parsePayload(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

describe('hep-mcp project_root admission', () => {
  let tmpRoot: string;
  let project: string;
  let alias: string;
  let outside: string;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    tmpRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hep-root-admission-')));
    project = path.join(tmpRoot, 'project');
    alias = path.join(tmpRoot, 'alias');
    outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(path.join(project, '.nullius'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(project, alias, 'dir');
    process.env.HEP_DATA_DIR = path.join(tmpRoot, 'env-hep-data');
  });

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  describe('tool calls', () => {
    it('admits a root reached through an alias in canonical form', async () => {
      const result = await handleToolCall('hep_health', { project_root: alias, check_inspire: false });

      expect(result.isError).not.toBe(true);
      const payload = parsePayload(result);
      const dataDir = path.join(project, 'artifacts', 'hep-mcp');
      expect(payload.config.hep_data_dir.project_root).toBe(project);
      expect(payload.config.hep_data_dir.path).toBe(dataDir);
      expect(payload.config.pdg.data_dir).toBe(path.join(dataDir, 'pdg'));
    });

    it.each([
      ['canonically', false],
      ['through the alias', true],
    ])('refuses a symlinked artifacts directory below the root (root spelled %s)', async (_label, viaAlias) => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');
      const projectRoot = viaAlias ? alias : project;

      const result = await handleToolCall('hep_health', { project_root: projectRoot, check_inspire: false });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a symlinked hep-mcp data directory below the root', async () => {
      fs.mkdirSync(path.join(project, 'artifacts'));
      fs.symlinkSync(outside, path.join(project, 'artifacts', 'hep-mcp'), 'dir');

      const result = await handleToolCall('hep_health', { project_root: alias, check_inspire: false });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a dangling artifacts symlink instead of creating its target', async () => {
      const missing = path.join(tmpRoot, 'missing');
      fs.symlinkSync(missing, path.join(project, 'artifacts'), 'dir');

      const result = await handleToolCall('hep_health', { project_root: project, check_inspire: false });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('refuses a symlinked PDG directory derived from the root', async () => {
      fs.mkdirSync(path.join(project, 'artifacts', 'hep-mcp'), { recursive: true });
      fs.symlinkSync(outside, path.join(project, 'artifacts', 'hep-mcp', 'pdg'), 'dir');

      const result = await handleToolCall('hep_health', { project_root: alias, check_inspire: false });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
    });

    it('applies the external-project policy: a directory inside the nullius checkout is refused', async () => {
      const insideCheckout = path.dirname(fileURLToPath(import.meta.url));

      const result = await handleToolCall('hep_health', { project_root: insideCheckout, check_inspire: false });

      expect(result.isError).toBe(true);
      const payload = parsePayload(result);
      expect(payload.error.code).toBe('INVALID_PARAMS');
      expect(payload.error.message).toMatch(/outside the nullius dev repo/);
    });

    it.each([
      ['alias root, canonical output_dir', 'alias', 'project'],
      ['canonical root, alias output_dir', 'project', 'alias'],
    ])('accepts an output_dir spelled differently from project_root (%s)', async (_label, rootSpelling, dirSpelling) => {
      const spelled = (which: string) => (which === 'alias' ? alias : project);
      const result = await handleToolCall('hep_health', {
        project_root: spelled(rootSpelling),
        check_inspire: false,
        options: { output_dir: path.join(spelled(dirSpelling), 'artifacts', 'hep-mcp', 'arxiv_sources', 'x') },
      });

      expect(result.isError).not.toBe(true);
    });
  });

  describe('caller paths compared with the data directory', () => {
    it('respells an alias path under the data directory, before and after the directory exists', () => {
      const dataDir = path.join(project, 'artifacts', 'hep-mcp');
      const viaAlias = path.join(alias, 'artifacts', 'hep-mcp', 'sub', 'file.json');
      const expected = path.join(dataDir, 'sub', 'file.json');

      expect(resolvePathWithinParent(dataDir, viaAlias, 'output_dir')).toBe(expected);
      fs.mkdirSync(dataDir, { recursive: true });
      expect(resolvePathWithinParent(dataDir, viaAlias, 'output_dir')).toBe(expected);
    });

    it('still refuses alias paths that land outside the data directory', () => {
      const dataDir = path.join(project, 'artifacts', 'hep-mcp');
      fs.mkdirSync(dataDir, { recursive: true });
      fs.symlinkSync(outside, path.join(dataDir, 'linkout'), 'dir');

      // Inside the project but outside its data directory.
      expect(() => resolvePathWithinParent(dataDir, path.join(alias, 'notes'), 'output_dir')).toThrow(/must be within/);
      // Through a symlink below the data directory that points outside it.
      expect(() => resolvePathWithinParent(dataDir, path.join(alias, 'artifacts', 'hep-mcp', 'linkout', 'f'), 'output_dir'))
        .toThrow(/must be within/);
      // A relative path is resolved against the data directory and must stay inside as spelled.
      expect(() => resolvePathWithinParent(dataDir, '../elsewhere', 'output_dir')).toThrow(/must be within/);
    });

    it('refuses a dangling symlink below the data directory, as leaf or on the way, however spelled', () => {
      const dataDir = path.join(project, 'artifacts', 'hep-mcp');
      const evidenceDir = path.join(dataDir, 'evidence');
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.symlinkSync(path.join(outside, 'new.jsonl'), path.join(evidenceDir, 'catalog.jsonl'));
      fs.symlinkSync(path.join(outside, 'missing-dir'), path.join(dataDir, 'linkdir'), 'dir');

      for (const root of [project, alias]) {
        const leaf = path.join(root, 'artifacts', 'hep-mcp', 'evidence', 'catalog.jsonl');
        expect(() => resolvePathWithinParent(evidenceDir, leaf, 'catalog')).toThrow(expect.objectContaining({ code: 'UNSAFE_FS' }));
        const throughLink = path.join(root, 'artifacts', 'hep-mcp', 'linkdir', 'f.json');
        expect(() => resolvePathWithinParent(dataDir, throughLink, 'output_dir')).toThrow(expect.objectContaining({ code: 'UNSAFE_FS' }));
      }
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('still accepts a live symlink below the data directory that stays inside it', () => {
      const dataDir = path.join(project, 'artifacts', 'hep-mcp');
      fs.mkdirSync(path.join(dataDir, 'evidence'), { recursive: true });
      fs.symlinkSync(path.join(dataDir, 'evidence'), path.join(dataDir, 'inner-link'), 'dir');

      const viaAlias = path.join(alias, 'artifacts', 'hep-mcp', 'inner-link', 'f.json');
      expect(resolvePathWithinParent(dataDir, viaAlias, 'output_dir')).toBe(path.join(dataDir, 'inner-link', 'f.json'));
    });
  });
});
