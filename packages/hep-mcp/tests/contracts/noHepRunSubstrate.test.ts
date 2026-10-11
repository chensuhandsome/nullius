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
// (hep://runs URIs, <data root>/runs/<id> directories, hep_run_* tools) must
// not come back; tools that write files take a caller-chosen output_dir
// inside the project instead.
const FORBIDDEN = [
  { label: 'hep_run_uri', re: /hep:\/\/runs/ },
  { label: 'hep_run_tool', re: /\bhep_run_[a-z_]+/ },
  { label: 'runs_data_subdir', re: /ensureSubdir\(\s*['"]runs['"]\s*\)/ },
  { label: 'run_dir_helper', re: /\bgetRun(?:Dir|sDir|ArtifactPath|ManifestPath|ArtifactsDir)\b/ },
];

describe('hep-mcp keeps no run substrate of its own', () => {
  it('no hep-mcp source file builds hep://runs URIs, hep run directories or hep_run_* tools', () => {
    const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
    const offenders = collectSourceFiles(srcRoot).flatMap(filePath => {
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      return lines.flatMap((line, index) => FORBIDDEN
        .filter(check => check.re.test(line))
        .map(check => `${path.relative(srcRoot, filePath)}:L${index + 1}:${check.label}`));
    });
    expect(offenders).toEqual([]);
  });
});
