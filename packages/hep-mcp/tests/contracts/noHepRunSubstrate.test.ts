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
// a string, so every such literal is refused except where it names the
// reserved team/runs prefix that output_dir admission refuses.
const FORBIDDEN = [
  { label: 'hep_run_uri', re: /hep:\/\/runs/ },
  { label: 'hep_run_tool', re: /\bhep_run_[a-z_]+/ },
  { label: 'runs_path_segment', re: /(?<!team)[/'"`]runs[/'"`]/ },
  { label: 'run_dir_helper', re: /\bgetRun(?:Dir|sDir|ArtifactPath|ManifestPath|ArtifactsDir)\b/ },
  { label: 'run_substrate_name', re: /\b(?:createRun|listRuns|RunManifest|run_manifest|runManifestUri)\b/ },
];

const ALLOWED_LINES = new Set([
  "  ['team', 'runs'],",
]);

function offendersIn(lines: string[], where: (index: number) => string): string[] {
  return lines.flatMap((line, index) => (ALLOWED_LINES.has(line)
    ? []
    : FORBIDDEN.filter(check => check.re.test(line)).map(check => `${where(index)}:${check.label}`)));
}

describe('hep-mcp keeps no run substrate of its own', () => {
  it('no hep-mcp source file builds hep://runs URIs, run directories, run manifests or hep_run_* tools', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const offenders = collectSourceFiles(srcRoot).flatMap(filePath => offendersIn(
      fs.readFileSync(filePath, 'utf-8').split('\n'),
      index => `${path.relative(srcRoot, filePath)}:L${index + 1}`,
    ));
    expect(offenders).toEqual([]);
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
    ];
    for (const line of rebuilt) {
      expect(offendersIn([line], () => 'fixture'), line).not.toEqual([]);
    }
    expect(offendersIn([
      "  ['team', 'runs'],",
      "'and may not lie under .nullius/, team/runs/ or artifacts/hep-mcp/.'",
      "const label = 'runtime';",
      'const reruns = 2;',
    ], () => 'fixture')).toEqual([]);
  });
});
