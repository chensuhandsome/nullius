import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { getTools, handleToolCall } from '../../src/tools/index.js';
import { resolvePathWithinParent } from '../../src/data/pathGuard.js';
import { withHepDataRoot } from '../../src/data/dataDir.js';
import { linkKbNotes } from '../../src/admin/linkKbNotes.js';
import { migratePapersCache } from '../../src/admin/migratePapersCache.js';
import { prunePaperCache } from '../../src/admin/prunePaperCache.js';
import { HEP_PAPERS_CACHE_DIR_ENV, materializeCacheEntry } from '../../src/data/papersCache.js';

// Every alias here is an explicit symlink built by the test, so the cases
// discriminate on hosts whose temp directory is not itself reached through
// an alias (Linux CI), as well as on macOS.

const ENV_KEYS = ['HEP_DATA_DIR', 'PDG_DATA_DIR', 'HEP_DOWNLOAD_DIR', 'ARXIV_DOWNLOAD_DIR', 'WRITING_PROGRESS_DIR', HEP_PAPERS_CACHE_DIR_ENV];

function parsePayload(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(result.content[0]!.text);
}

function writePaperJson(projectRoot: string, paperId: string, identifier: string): string {
  const paperDir = path.join(projectRoot, 'artifacts', 'hep-mcp', 'projects', 'p1', 'papers', paperId);
  fs.mkdirSync(paperDir, { recursive: true });
  fs.writeFileSync(
    path.join(paperDir, 'paper.json'),
    JSON.stringify({ version: 1, source: { kind: 'latex', identifier, main_tex: 'main.tex' } }),
  );
  return paperDir;
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
    process.env[HEP_PAPERS_CACHE_DIR_ENV] = path.join(tmpRoot, 'papers-cache');
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

      const result = await handleToolCall('hep_project_create', { project_root: projectRoot, name: 'escape' });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a symlinked hep-mcp data directory below the root', async () => {
      fs.mkdirSync(path.join(project, 'artifacts'));
      fs.symlinkSync(outside, path.join(project, 'artifacts', 'hep-mcp'), 'dir');

      const result = await handleToolCall('hep_project_create', { project_root: alias, name: 'escape' });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('refuses a dangling artifacts symlink instead of creating its target', async () => {
      const missing = path.join(tmpRoot, 'missing');
      fs.symlinkSync(missing, path.join(project, 'artifacts'), 'dir');

      const result = await handleToolCall('hep_project_create', { project_root: project, name: 'escape' });

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

  describe('admin tools', () => {
    it('migratePapersCache admits the root in canonical form and derives the data root from it', async () => {
      const report = await migratePapersCache({ project_root: alias });

      expect(report.project_root).toBe(project);
      expect(report.hep_data_root).toBe(path.join(project, 'artifacts', 'hep-mcp'));
    });

    it('migratePapersCache refuses a symlinked artifacts directory and leaves its target untouched', async () => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');
      const paperDir = writePaperJson(project, 'arxiv-X', 'arxiv:2401.09012v3');
      const extracted = path.join(paperDir, 'sources', 'latex', 'extracted');
      fs.mkdirSync(extracted, { recursive: true });
      fs.writeFileSync(path.join(extracted, 'main.tex'), 'A\n');

      await expect(migratePapersCache({ project_root: alias, apply: true })).rejects.toMatchObject({ code: 'UNSAFE_FS' });

      expect(fs.lstatSync(extracted).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(extracted, 'main.tex'), 'utf-8')).toBe('A\n');
    });

    it('prunePaperCache reports references against the canonical root', async () => {
      await materializeCacheEntry('arxiv:2401.09012v3', async tmpContent => {
        fs.mkdirSync(path.join(tmpContent, 'latex', 'extracted'), { recursive: true });
        fs.writeFileSync(path.join(tmpContent, 'latex', 'extracted', 'main.tex'), 'X');
        return { source_type: 'latex', fetched_via: 'manual_import', main_path: 'latex/extracted/main.tex' };
      });
      writePaperJson(project, 'arxiv-X', 'arxiv:2401.09012v3');

      const report = await prunePaperCache({ project_roots: [alias] });

      expect(report.project_roots).toEqual([project]);
      expect(report.plans).toHaveLength(1);
      expect(report.plans[0]!.referenced_by).toEqual([project]);
    });

    it('prunePaperCache refuses a symlinked artifacts directory and an uninitialized root', async () => {
      const uninitialized = path.join(tmpRoot, 'uninitialized');
      fs.mkdirSync(uninitialized);
      await expect(prunePaperCache({ project_roots: [uninitialized] })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });

      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');
      await expect(prunePaperCache({ project_roots: [alias] })).rejects.toMatchObject({ code: 'UNSAFE_FS' });
    });

    it('linkKbNotes admits the root in canonical form', async () => {
      const report = await linkKbNotes({ project_root: alias });

      expect(report.project_root).toBe(project);
      expect(report.hep_data_root).toBe(path.join(project, 'artifacts', 'hep-mcp'));
      expect(report.kb_dir).toBe(path.join(project, '.nullius', 'knowledge_base'));
    });

    it('a hep_data_root override inside the project is reached through real directories only', async () => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');
      const paperDir = writePaperJson(project, 'arxiv-X', 'arxiv:2401.09012v3');
      const extracted = path.join(paperDir, 'sources', 'latex', 'extracted');
      fs.mkdirSync(extracted, { recursive: true });
      fs.writeFileSync(path.join(extracted, 'main.tex'), 'A\n');

      for (const root of [project, alias]) {
        const override = path.join(root, 'artifacts', 'hep-mcp');
        await expect(migratePapersCache({ project_root: project, hep_data_root: override, apply: true }))
          .rejects.toMatchObject({ code: 'UNSAFE_FS' });
        await expect(prunePaperCache({ project_roots: [project], hep_data_root: override }))
          .rejects.toMatchObject({ code: 'UNSAFE_FS' });
        await expect(linkKbNotes({ project_root: project, hep_data_root: override }))
          .rejects.toMatchObject({ code: 'UNSAFE_FS' });
      }
      expect(fs.lstatSync(extracted).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(extracted, 'main.tex'), 'utf-8')).toBe('A\n');
    });

    it('a hep_data_root override inside the project is reported under the canonical root', async () => {
      const report = await migratePapersCache({ project_root: alias, hep_data_root: path.join(alias, 'custom-hep') });

      expect(report.hep_data_root).toBe(path.join(project, 'custom-hep'));
    });

    it('a relative or blank hep_data_root override is refused rather than resolved or ignored', async () => {
      for (const override of ['relative/hep', '   ', '']) {
        await expect(migratePapersCache({ project_root: project, hep_data_root: override }))
          .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(prunePaperCache({ project_roots: [project], hep_data_root: override }))
          .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
        await expect(linkKbNotes({ project_root: project, hep_data_root: override }))
          .rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      }
    });

    it('through the dispatcher, an empty hep_data_root does not fall back to the default data tree', async () => {
      const paperDir = writePaperJson(project, 'arxiv-X', 'arxiv:2401.09012v3');
      const extracted = path.join(paperDir, 'sources', 'latex', 'extracted');
      fs.mkdirSync(extracted, { recursive: true });
      fs.writeFileSync(path.join(extracted, 'main.tex'), 'A\n');

      const migrate = await handleToolCall('hep_admin_migrate_papers_cache', {
        project_root: project, hep_data_root: '', apply: true, _confirm: true,
      });
      expect(migrate.isError).toBe(true);
      expect(parsePayload(migrate).error.code).toBe('INVALID_PARAMS');
      expect(fs.lstatSync(extracted).isDirectory()).toBe(true);

      const prune = await handleToolCall('hep_admin_prune_paper_cache', {
        project_roots: [project], hep_data_root: '', apply: true, _confirm: true,
      });
      expect(prune.isError).toBe(true);
      expect(parsePayload(prune).error.code).toBe('INVALID_PARAMS');
    });

    it('a hep_data_root override outside the project stays an independent data root', async () => {
      const external = path.join(tmpRoot, 'external-hep');

      const report = await migratePapersCache({ project_root: alias, hep_data_root: external });

      expect(report.project_root).toBe(project);
      expect(report.hep_data_root).toBe(external);
    });

    it('through the dispatcher, an admin data root override is used even when the default layout is unusable', async () => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');
      const external = path.join(tmpRoot, 'external-hep');
      fs.mkdirSync(external);

      const migrate = await handleToolCall('hep_admin_migrate_papers_cache', { project_root: alias, hep_data_root: external });
      expect(migrate.isError).not.toBe(true);
      expect(parsePayload(migrate)).toMatchObject({ project_root: project, hep_data_root: external });

      const link = await handleToolCall('hep_admin_link_kb_notes', { project_root: alias, hep_data_root: path.join(alias, 'custom-hep') });
      expect(link.isError).not.toBe(true);
      expect(parsePayload(link)).toMatchObject({ project_root: project, hep_data_root: path.join(project, 'custom-hep') });

      const prune = await handleToolCall('hep_admin_prune_paper_cache', { project_roots: [alias], hep_data_root: external });
      expect(prune.isError).not.toBe(true);
      expect(parsePayload(prune).project_roots).toEqual([project]);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it('a self-resolving admin tool is not refused by an outer call\'s data root', async () => {
      // The outer scope is another project whose derived PDG directory is a symlink.
      const other = path.join(tmpRoot, 'other');
      fs.mkdirSync(path.join(other, '.nullius'), { recursive: true });
      fs.mkdirSync(path.join(other, 'artifacts', 'hep-mcp'), { recursive: true });
      fs.symlinkSync(outside, path.join(other, 'artifacts', 'hep-mcp', 'pdg'), 'dir');
      const external = path.join(tmpRoot, 'external-hep');

      const result = await withHepDataRoot(other, () =>
        handleToolCall('hep_admin_migrate_papers_cache', { project_root: alias, hep_data_root: external }));

      expect(result.isError).not.toBe(true);
      expect(parsePayload(result)).toMatchObject({ project_root: project, hep_data_root: external });
    });

    it('through the dispatcher, admin tools still refuse an in-project override reached through a symlink', async () => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');

      const result = await handleToolCall('hep_admin_migrate_papers_cache', {
        project_root: project,
        hep_data_root: path.join(alias, 'artifacts', 'hep-mcp'),
        apply: true,
        _confirm: true,
      });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
    });

    it('advertises project_root as required for the admin tools that need it', () => {
      for (const name of ['hep_admin_migrate_papers_cache', 'hep_admin_link_kb_notes']) {
        const tool = getTools('standard').find(candidate => candidate.name === name);
        expect(tool?.inputSchema.required).toContain('project_root');
      }
    });

    it('does not advertise the per-call project_root routing field on a tool that resolves its own roots', () => {
      const prune = getTools('standard').find(candidate => candidate.name === 'hep_admin_prune_paper_cache');
      expect(prune?.inputSchema.required).toContain('project_roots');
      expect(prune?.inputSchema.properties).not.toHaveProperty('project_root');
    });

    it('hep_admin_link_kb_notes refuses a symlinked artifacts directory', async () => {
      fs.symlinkSync(outside, path.join(project, 'artifacts'), 'dir');

      const result = await handleToolCall('hep_admin_link_kb_notes', { project_root: alias });

      expect(result.isError).toBe(true);
      expect(parsePayload(result).error.code).toBe('UNSAFE_FS');
    });
  });
});
