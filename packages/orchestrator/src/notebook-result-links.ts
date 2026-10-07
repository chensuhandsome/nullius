import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectionFromRegistryState, textOutsideNotebookCurrentState, type CurrentStateProjection } from './notebook-current-state.js';
import { validateResultRegistry } from './result-registry.js';
import { notebookSectionLinkTargets } from './notebook-run-links.js';

export type NotebookResultLinks = {
  status: 'not_applicable' | 'unavailable' | 'missing_links' | 'linked';
  results: Array<{ result_id: string; artifact: string | null; sections: string[] }>;
  missing_result_ids: string[];
  reason: string | null;
  scope: string;
};

// Normalize project-relative Markdown destinations, without reading linked
// files or following symlinks. Registry validation owns artifact validity.
function localTarget(raw: string): string | null {
  const unwrapped = raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  let target: string;
  try { target = decodeURIComponent(unwrapped.split(/[?#]/, 1)[0]!); }
  catch { return null; }
  if (!target || /^[a-z][a-z\d+.-]*:/i.test(target) || path.posix.isAbsolute(target)
    || target.includes('\\')) return null;
  const normalized = path.posix.normalize(target);
  return normalized === '..' || normalized.startsWith('../') ? null : normalized;
}

/** Necessary traceability check, NOT a prose or derivation quality verdict.
 * Status/current expose missing links even in file mode. Fold consumers may
 * require the declared result in a rewritten section, not global cleanliness.
 * Automatic state tables, comments and code examples cannot satisfy it. */
export function checkNotebookResultLinks(
  projectRoot: string, projection: CurrentStateProjection,
): NotebookResultLinks {
  const report: NotebookResultLinks = {
    status: 'not_applicable', results: [], missing_result_ids: [], reason: null,
    scope: 'Direct artifact links in human ## sections only; no recursive, HTML, shortcut or indented-link scan. '
      + 'Links do not establish explanation, derivation completeness, correctness or verification.',
  };
  if (projection.current_rows.length === 0) return report;
  let text: string;
  try { text = fs.readFileSync(path.join(projectRoot, 'research_notebook.md'), 'utf-8'); }
  catch {
    return { ...report, status: 'unavailable', reason: 'research_notebook.md missing or unreadable' };
  }
  if (textOutsideNotebookCurrentState(text) === null) {
    return { ...report, status: 'unavailable', reason: 'ambiguous notebook current-state markers' };
  }
  const sections = notebookSectionLinkTargets(text)
    .map(section => ({ ...section, targets: new Set(section.targets.map(localTarget).filter(Boolean)) }));
  report.results = projection.current_rows.map(row => {
    const target = row.artifact === null ? null : localTarget(row.artifact);
    return {
      result_id: row.result_id, artifact: row.artifact,
      sections: target === null ? [] : sections.filter(section => section.targets.has(target)).map(section => section.heading),
    };
  });
  report.missing_result_ids = report.results.filter(row => row.sections.length === 0).map(row => row.result_id);
  report.status = report.missing_result_ids.length ? 'missing_links' : 'linked';
  return report;
}

/** Read-only closeout check for external-agent/file-mode work. Result-scoped
 * checks do not turn unrelated historical notebook gaps into blockers. */
export function runNotebookCheck(
  projectRoot: string, resultId: string | undefined, json: boolean,
  io: { stdout: (text: string) => void; stderr: (text: string) => void },
): number {
  try {
    const registry = validateResultRegistry(projectRoot);
    const projection = projectionFromRegistryState(registry);
    // A malformed row can hide another definition of the selected id, so it
    // remains global. Other row-local defects do not block an unrelated id.
    if (!projection.registry_block_found || registry.issues.some(issue => issue.code === 'malformed_result_row')
      || (resultId === undefined && projection.issue_codes.length > 0)) {
      throw new Error('results registry absent or defective; inspect nullius current before checking notebook links');
    }
    if (resultId !== undefined) {
      projection.current_rows = projection.current_rows.filter(row => row.result_id === resultId);
      if (projection.current_rows.length === 0) throw new Error(`no current registered result: ${resultId}`);
      if (registry.defective_result_ids.has(resultId)) throw new Error(`defective current result: ${resultId}`);
    }
    const report = checkNotebookResultLinks(projectRoot, projection);
    if (json) io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    else io.stdout(`Human notebook result links: ${report.status}. ${report.reason ?? report.missing_result_ids.join(', ')}\n${report.scope}\n`);
    return report.status === 'unavailable' ? 2 : report.status === 'missing_links' ? 1 : 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (json) io.stdout(`${JSON.stringify({ status: 'unavailable', reason })}\n`);
    else io.stderr(`notebook check: ${reason}\n`);
    return 2;
  }
}
