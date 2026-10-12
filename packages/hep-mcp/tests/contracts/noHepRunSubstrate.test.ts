import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

function collectSourceFiles(dirPath: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(fullPath));
    else if (entry.isFile() && fullPath.endsWith('.ts')) out.push(fullPath);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// hep-mcp is a tool package: runs belong to the orchestrator
// (<project>/artifacts/runs/<run_id>). Its own former run substrate
// (hep://runs URIs, <data root>/runs/<id> directories, run manifests,
// hep_run_* tools) must not come back; tools that write files take a
// caller-chosen output_dir inside the project instead.
//
// Building a runs directory under any root needs the path segment 'runs' as
// a string, in any letter case (the default macOS file systems ignore case),
// so every such literal is refused. The only exceptions are the
// exact source lines that name the reserved team/runs prefix in order to
// refuse it (output_dir admission and the output_dir and project_root
// parameter descriptions), keyed by
// file and full line text; any other occurrence fails.
const FORBIDDEN = [
  { label: 'hep_run_uri', re: /hep:\/\/runs/i },
  { label: 'hep_run_tool', re: /\bhep_run_[a-z_]+/i },
  { label: 'runs_path_segment', re: /[/'"`]runs[/'"`]/i },
  { label: 'run_dir_helper', re: /\bgetRun(?:Dir|sDir|ArtifactPath|ManifestPath|ArtifactsDir)\b/ },
  { label: 'run_substrate_name', re: /\b(?:createRun|listRuns|RunManifest|run_manifest|runManifestUri)\b/ },
];

const ALLOWED_LINES = new Set([
  "core/outputDir.ts:  ['team', 'runs'],",
  "tools/registry/projectSchemas.ts:      + 'and may not lie under .nullius/, team/runs/ or artifacts/hep-mcp/. A call never replaces an existing file '",
  "tools/registry/shared.ts:  'Optional absolute path to an initialized nullius project root outside any nullius checkout; it is admitted in canonical (symlink-resolved) form. When set, the hep-mcp data for this call (paper/evidence projects, caches, downloads, PDG data) lives under <project_root>/artifacts/hep-mcp, which must be reached through real directories (a symlinked artifacts/, artifacts/hep-mcp/ or pdg/ is refused); otherwise HEP_DATA_DIR or the scratch default is used. Tools that write output files put them in their output_dir instead, which requires project_root and may not lie under the reserved areas .nullius/, team/runs/ or artifacts/hep-mcp/.';",
]);

function offendersIn(file: string, lines: string[], where: (index: number) => string): string[] {
  return lines.flatMap((line, index) => {
    if (ALLOWED_LINES.has(`${file}:${line}`)) return [];
    return FORBIDDEN.filter(check => check.re.test(line)).map(check => `${where(index)}:${check.label}`);
  });
}

describe('hep-mcp keeps no run substrate of its own', () => {
  it('no hep-mcp source file builds hep://runs URIs, run directories, run manifests or hep_run_* tools', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const files = collectSourceFiles(srcRoot);
    const offenders = files.flatMap(filePath => offendersIn(
      path.relative(srcRoot, filePath).split(path.sep).join('/'),
      fs.readFileSync(filePath, 'utf-8').split('\n'),
      index => `${path.relative(srcRoot, filePath)}:L${index + 1}`,
    ));
    expect(offenders).toEqual([]);
    // Every exception still names a line that exists, so a stale one is noticed.
    const present = new Set(files.flatMap(filePath => fs.readFileSync(filePath, 'utf-8').split('\n')
      .map(line => `${path.relative(srcRoot, filePath).split(path.sep).join('/')}:${line}`)));
    expect([...ALLOWED_LINES].filter(entry => !present.has(entry))).toEqual([]);
  });

  it('catches the ways a run substrate would be rebuilt (negative controls)', () => {
    const rebuilt = [
      "const dir = path.join(getDataDir(), 'runs', runId);",
      'const dir = path.join(dataRoot, "runs");',
      'const dir = `${dataDir}/runs/${id}`;',
      "export function createRun(name: string) {}",
      'const manifest: RunManifest = readManifest(dir);',
      "const uri = `hep://runs/${id}/manifest`;",
      "registerTool('hep_run_create', spec);",
      'const runsDir = getRunsDir();',
      "  ['team', 'runs', 'x'],",
      "const dir = 'steam/runs/';",
      "const dir = 'notteam/runs/';",
      "const dir = 'myteam/runs/';",
      "const dir = 'my-team/runs/';",
      "const dir = path.join(projectRoot, 'team/runs', runId);",
      "const dir = `${projectRoot}/team/runs/${runId}`;",
      "const dir = path.join(dataRoot, 'Runs', id);",
      "const dir = path.join(dataRoot, 'RUNS', id);",
      "const uri = `hep://Runs/${id}/manifest`;",
      "registerTool('HEP_RUN_CREATE', spec);",
      "  ['team', 'runs'],",
    ];
    for (const line of rebuilt) {
      expect(offendersIn('fixture.ts', [line], () => 'fixture'), line).not.toEqual([]);
    }
    expect(offendersIn('fixture.ts', [
      "const label = 'runtime';",
      "const dir = 'team/runs-old/x';",
      'const reruns = 2;',
    ], () => 'fixture')).toEqual([]);
  });
});
