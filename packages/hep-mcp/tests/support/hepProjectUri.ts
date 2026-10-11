import * as fs from 'fs';
import * as path from 'path';
import { getProject, listProjects } from '../../src/core/projects.js';
import { getPaper, listPapers } from '../../src/core/papers.js';
import { getProjectArtifactPath, getProjectPaperEvidenceCatalogPath } from '../../src/core/paths.js';

/**
 * Test-only reader for the `hep://projects/...` URIs that the paper/evidence
 * project tools return. hep-mcp itself serves no URI resources; tests read
 * the files those URIs name to check what the tools wrote.
 */
export function readHepProjectUri(uri: string): { uri: string; mimeType?: string; text: string } {
  const url = new URL(uri);
  if (url.protocol !== 'hep:' || url.host !== 'projects') throw new Error(`not a hep://projects URI: ${uri}`);
  const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));

  if (segments.length === 0) {
    const projects = listProjects().map(p => ({ project_id: p.project_id, name: p.name, uri: `hep://projects/${encodeURIComponent(p.project_id)}` }));
    return { uri, mimeType: 'application/json', text: JSON.stringify({ projects }, null, 2) };
  }
  const projectId = segments[0]!;
  if (segments.length === 1) {
    return { uri, mimeType: 'application/json', text: JSON.stringify(getProject(projectId), null, 2) };
  }
  if (segments.length === 3 && segments[1] === 'artifact') {
    const artifactPath = getProjectArtifactPath(projectId, segments[2]!);
    return { uri, mimeType: path.extname(artifactPath) === '.jsonl' ? 'application/x-ndjson' : 'application/json', text: fs.readFileSync(artifactPath, 'utf-8') };
  }
  if (segments.length === 2 && segments[1] === 'papers') {
    const papers = listPapers(projectId).map(p => ({
      paper_id: p.paper_id,
      uri: `hep://projects/${encodeURIComponent(projectId)}/papers/${encodeURIComponent(p.paper_id)}`,
      evidence_catalog_uri: p.artifacts?.evidence_catalog?.uri,
    }));
    return { uri, mimeType: 'application/json', text: JSON.stringify({ project_id: projectId, papers }, null, 2) };
  }
  if (segments.length === 3 && segments[1] === 'papers') {
    return { uri, mimeType: 'application/json', text: JSON.stringify(getPaper(projectId, segments[2]!), null, 2) };
  }
  if (segments.length === 5 && segments[1] === 'papers' && segments[3] === 'evidence' && segments[4] === 'catalog') {
    return { uri, mimeType: 'application/x-ndjson', text: fs.readFileSync(getProjectPaperEvidenceCatalogPath(projectId, segments[2]!), 'utf-8') };
  }
  throw new Error(`unknown hep://projects URI: ${uri}`);
}

/** Read a file a tool reported by its project-relative path. */
export function readProjectFile(projectRoot: string, projectRelativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, ...projectRelativePath.split('/')), 'utf-8');
}

/** A minimal initialized nullius project root (a `.nullius/` marker) inside `parent`. */
export function makeProjectRoot(parent: string, name = 'project'): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, '.nullius'), { recursive: true });
  return root;
}
