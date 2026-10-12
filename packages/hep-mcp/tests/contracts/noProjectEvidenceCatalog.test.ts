import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import { getTools } from '../../src/tools/index.js';

function collectSourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.ts')) out.push(fullPath);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// hep-mcp keeps no paper/evidence projects, evidence catalogs or user-global
// papers cache: those tools were removed, and their historical directories
// (<data root>/projects/<project_id>/..., including catalog.jsonl files) are
// evidence to be read in place by the rule in docs/URI_REGISTRY.md, never
// rebuilt or rewritten by a tool.
const REMOVED_TOOLS = [
  'hep_project_create',
  'hep_project_get',
  'hep_project_list',
  'hep_project_build_evidence',
  'hep_project_query_evidence',
  'hep_project_playback_evidence',
  'hep_admin_import_paper',
  'hep_admin_migrate_papers_cache',
  'hep_admin_prune_paper_cache',
  'hep_admin_link_kb_notes',
];

const FORBIDDEN = [
  { label: 'hep_project_uri', re: /hep:\/\/projects/i },
  { label: 'project_or_admin_tool', re: /\bhep_(?:project|admin)_[a-z_]+/i },
  { label: 'evidence_catalog_file', re: /catalog\.jsonl/i },
  { label: 'papers_cache', re: /\bpapers_?cache/i },
  { label: 'projects_path_segment', re: /[/'"`]projects[/'"`]/i },
];

function offendersIn(lines: string[], where: (index: number) => string): string[] {
  return lines.flatMap((line, index) =>
    FORBIDDEN.filter(check => check.re.test(line)).map(check => `${where(index)}:${check.label}`));
}

describe('hep-mcp keeps no paper/evidence projects, evidence catalogs or papers cache', () => {
  it('registers none of the removed project, evidence-catalog or cache admin tools', () => {
    const names = new Set(getTools('full').map(tool => tool.name));
    expect(REMOVED_TOOLS.filter(name => names.has(name))).toEqual([]);
  });

  it('no hep-mcp source file builds project URIs, project directories, catalogs or the papers cache', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const offenders = collectSourceFiles(srcRoot).flatMap(filePath => offendersIn(
      fs.readFileSync(filePath, 'utf-8').split('\n'),
      index => `${path.relative(srcRoot, filePath)}:L${index + 1}`,
    ));
    expect(offenders).toEqual([]);
  });

  it('catches the ways the removed substrate would be rebuilt (negative controls)', () => {
    const rebuilt = [
      "const uri = `hep://projects/${id}`;",
      "registerTool('hep_project_create', spec);",
      "registerTool('HEP_ADMIN_IMPORT_PAPER', spec);",
      "const catalogPath = path.join(evidenceDir, 'catalog.jsonl');",
      "const root = path.join(os.homedir(), '.nullius', 'hep-mcp', 'papers_cache');",
      "import { ensureInCache } from '../data/papersCache.js';",
      "const dir = path.join(getDataDir(), 'projects', projectId);",
      'const dir = `${dataDir}/projects/${id}`;',
    ];
    for (const line of rebuilt) {
      expect(offendersIn([line], () => 'fixture'), line).not.toEqual([]);
    }
    expect(offendersIn([
      "const label = 'project_root';",
      'const projectRoot = admitProjectRoot(raw);',
      "const dir = path.join(projectRoot, 'artifacts', 'hep-mcp');",
      'let classifyPapersCache = null;',
    ], () => 'fixture')).toEqual([]);
  });
});
