import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkNotebookResultLinks } from '../src/notebook-result-links.js';
import { renderCurrentStateBlock, refreshNotebookCurrentState, type CurrentStateProjection } from '../src/notebook-current-state.js';
import { buildTraceabilityView, renderTraceabilityProse } from '../src/traceability-view.js';
import { stampRunDirectory } from '../src/run-stamp.js';
import { runCli } from '../src/cli.js';
import { parseCliArgs } from '../src/cli-args.js';
import { setCurrentResult } from '../src/result-registry.js';

let root: string;
const projection: CurrentStateProjection = {
  registry_block_found: true, total_rows: 1, issue_codes: [],
  current_rows: [{ result_id: 'estimate', run_id: '20261001-estimate-r1', effective_commit: 'a'.repeat(40),
    has_snapshot: false, artifact: 'docs/estimate.md', defective: false }],
};
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-links-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function write(body: string): void { fs.writeFileSync(path.join(root, 'research_notebook.md'), body); }
function check(body: string) { write(body); return checkNotebookResultLinks(root, projection); }

describe('human notebook links to adopted artifacts', () => {
  it('parses result-scoped check and rejects missing or irrelevant selectors', () => {
    expect(parseCliArgs(['notebook', 'check', '--result', 'estimate', '--json'])).toMatchObject({ action: 'check', resultId: 'estimate', json: true });
    expect(() => parseCliArgs(['notebook', 'check', '--result'])).toThrow();
    expect(() => parseCliArgs(['notebook', 'sync', '--result', 'estimate'])).toThrow();
    expect(() => parseCliArgs(['notebook', 'check', '--result', 'a', '--result', 'b'])).toThrow();
  });
  it('has no result obligation before any adoption, and reports unreadable notebooks honestly', () => {
    expect(checkNotebookResultLinks(root, { ...projection, current_rows: [], total_rows: 0 }).status).toBe('not_applicable');
    expect(checkNotebookResultLinks(root, projection).status).toBe('unavailable');
  });
  it('rejects automatic-table-only progress even when the table is exact', () => {
    const report = check(`# Notebook\n${renderCurrentStateBlock(projection)}\n## Question\nWe will calculate the estimate.\n`);
    expect(report.status).toBe('missing_links');
    expect(report.missing_result_ids).toEqual(['estimate']);
  });
  it.each([
    '```md\n[evidence](docs/estimate.md)\n```',
    '`[evidence](docs/estimate.md)`',
    '<!--\n[evidence](docs/estimate.md)\n-->',
    '<!-- removed evidence\n[evidence](docs/estimate.md)',
    '<!-- removed evidence\n\n## Hidden section\n[evidence](docs/estimate.md)',
    '    [evidence](docs/estimate.md)',
    '- Example\n\n      [evidence](docs/estimate.md)',
    String.raw`\[evidence](docs/estimate.md)`,
    '![image](docs/estimate.md)',
    '![label [evidence](docs/estimate.md)](docs/image.png)',
    '![label [evidence](docs/estimate.md)](docs/image.png)\n\n[evidence]\n\n[evidence]: docs/estimate.md',
    '![image][ref]\n\n[ref]: docs/estimate.md',
    '![image][]\n\n[image]: docs/estimate.md',
    '<pre>\n[evidence](docs/estimate.md)\n</pre>',
    '<pre>\n[evidence](docs/estimate.md)',
    '<div>\n[evidence](docs/estimate.md)\n</div>',
    '> <div>\n> [evidence](docs/estimate.md)\n> </div>',
    '- <div>\n  [evidence](docs/estimate.md)\n  </div>',
    '<span title="[evidence](docs/estimate.md)">Label</span>',
    '<span title="[fake](docs/estimate.md)">Label</span>\n[evidence]\n\n[evidence]: docs/estimate.md',
    'A note <textarea>[evidence](docs/estimate.md)</textarea>.',
    'A note <script>[evidence](docs/estimate.md)</script>.',
    'A note <code>[evidence](docs/estimate.md)</code>.',
    '<div><textarea>\n\n[evidence](docs/estimate.md)\n\n</textarea></div>',
    '<div>\n```md\n[evidence](docs/estimate.md)\n```\n[evidence](docs/estimate.md)\n</div>',
    '<custom-element>\n[evidence](docs/estimate.md)\n</custom-element>',
    '---\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '* * *\n<span>\n[evidence](docs/estimate.md)\n</span>',
    'A heading\n===\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '    Example code\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '<!--\n```\n-->\n\n```md\n[evidence](docs/estimate.md)\n```',
    '<?instruction\n[evidence](docs/estimate.md)',
    '<!DECLARATION\n[evidence](docs/estimate.md)',
    '<![CDATA[\n[evidence](docs/estimate.md)',
    '<div>\n[hidden]: docs/estimate.md\n</div>\n\n[evidence][hidden]',
    '[unused]: docs/estimate.md',
    '[run](artifacts/runs/20261001-estimate-r1/)',
    '[different](docs/other.md)',
    '[external](https://example.org/docs/estimate.md)',
  ])('does not count hidden, example, unused or different evidence: %s', body => {
    expect(check(`## Estimate\n\n${body}\n`).status).toBe('missing_links');
  });
  it('matches direct normalized and encoded artifact destinations with a fragment', () => {
    const report = check('## Estimate\nThe estimate follows from the stated assumptions; see [evidence](<./docs/%65stimate.md#limits>).');
    expect(report.results[0]!.sections).toEqual(['Estimate']);
    expect(report.status).toBe('linked');
    expect(report.scope).toContain('do not establish');
  });
  it('recognizes used explicit references across sections without counting unused definitions', () => {
    const report = check('## Estimate\nSee [derivation][ref].\n\n## References\n[ref]: docs/estimate.md\n');
    expect(report.results[0]!.sections).toEqual(['Estimate']);
  });
  it('binds links to real heading lines when Unicode whitespace only looks like a heading', () => {
    expect(check('##\u00a0Ghost\n\n## Estimate\n[evidence](docs/estimate.md)').results[0]!.sections).toEqual(['Estimate']);
    expect(check('##\u00a0Ghost\n[evidence](docs/estimate.md)\n\n## Estimate\nNo evidence here.').status).toBe('missing_links');
  });
  it('honors an HTML container opened in a human section heading', () => {
    expect(check('## Estimate <textarea>\n\n[evidence](docs/estimate.md)').status).toBe('missing_links');
    expect(check('## Estimate <textarea>\n\nExample\n\n</textarea>\n\n[evidence](docs/estimate.md)').status).toBe('linked');
  });
  it('recognizes a raw-text closing tag inside comment-looking text', () => {
    expect(check('## Estimate\n\nA note <textarea><!-- </textarea> --> [evidence](docs/estimate.md)').status).toBe('linked');
    expect(check('## Estimate\n\nA note <textarea><!-- example --> [evidence](docs/estimate.md)').status).toBe('missing_links');
  });
  it('ignores comment syntax inside examples and accepts document-scoped references', () => {
    const report = check('[ref]: docs/estimate.md\n\n```html\n<!--\n```\n\n## Estimate\nSee [evidence][ref].');
    expect(report.results[0]!.sections).toEqual(['Estimate']);
  });
  it.each([
    '<!-- hidden -->\n[evidence](docs/estimate.md)',
    '<div>\n\n[evidence](docs/estimate.md)\n\n</div>',
    'An inline <span>[evidence](docs/estimate.md)</span>.',
    'A paragraph\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '=\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '--\n<span>\n[evidence](docs/estimate.md)\n</span>',
    '> [evidence](docs/estimate.md)',
    '- [evidence](docs/estimate.md)',
    'A note <textarea>example</textarea> then [evidence](docs/estimate.md).',
    '<!-- <textarea> -->\n[evidence](docs/estimate.md)',
  ])('preserves visible Markdown after or alongside HTML: %s', body => {
    expect(check(`## Estimate\n\n${body}\n`).status).toBe('linked');
  });
  it.each([
    ['docs/rate%.md', 'docs/rate%25.md'],
    ['docs/rate%25.md', 'docs/rate%2525.md'],
    ['docs/rate?1.md', 'docs/rate%3F1.md'],
  ])('matches literal artifact %s with its URI-encoded destination', (artifact, href) => {
    write(`## Estimate\n[evidence](${href}#limits)`);
    const report = checkNotebookResultLinks(root, { ...projection,
      current_rows: [{ ...projection.current_rows[0]!, artifact }] });
    expect(report.status).toBe('linked');
    write(`## Estimate\n[evidence][ref]\n\n[ref]: ${href}`);
    expect(checkNotebookResultLinks(root, { ...projection,
      current_rows: [{ ...projection.current_rows[0]!, artifact }] }).status).toBe('linked');
  });
  it('does not decode a literal registry filename into another artifact', () => {
    write('## Estimate\n[evidence](docs/rate%25.md)');
    const report = checkNotebookResultLinks(root, { ...projection,
      current_rows: [{ ...projection.current_rows[0]!, artifact: 'docs/rate%25.md' }] });
    expect(report.status).toBe('missing_links');
  });
  it('does not let one artifact stand for a different result from the same run', () => {
    write('## Estimate\nSee [evidence](docs/estimate.md).');
    const report = checkNotebookResultLinks(root, { ...projection, current_rows: [...projection.current_rows,
      { ...projection.current_rows[0]!, result_id: 'second', artifact: 'docs/second.md' }] });
    expect(report.missing_result_ids).toEqual(['second']);
  });
  it('exposes the diagnostic through status/current and enforces read-only file-mode closeout', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
    git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
    write('## Estimate\nWe will calculate it.\n');
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/estimate.md'), 'A scoped estimate.');
    fs.writeFileSync(path.join(root, 'docs/other.md'), 'Another result.');
    fs.writeFileSync(path.join(root, 'project_index.md'), '<!-- RESULT_REGISTRY_START -->\n| Result ID | Description & artifact | Artifact SHA-256 | Current run | Supersedes | Superseded by |\n|---|---|---|---|---|---|\n<!-- RESULT_REGISTRY_END -->\n');
    git('add', '.'); git('commit', '-qm', 'fixture');
    const run = projection.current_rows[0]!.run_id;
    fs.mkdirSync(path.join(root, 'artifacts/runs', run), { recursive: true });
    expect(stampRunDirectory(root, path.join(root, "artifacts/runs", run), { actor: 'test' }).kind).toBe('stamped');
    let registrationOutput = '';
    expect(await runCli(['result', 'set-current', 'estimate', '--run', run, '--artifact', 'docs/estimate.md'],
      { cwd: root, stdout: text => { registrationOutput += text; }, stderr: () => {} })).toBe(0);
    expect(registrationOutput).toContain('notebook check --result estimate before closeout');
    setCurrentResult(root, { resultId: 'other', runId: run, artifactRelPath: 'docs/other.md' });
    refreshNotebookCurrentState(root, { insertIfMissing: true });
    const view = buildTraceabilityView(root);
    expect(view.notebook.current_state_block.in_sync).toBe(true);
    expect(view.notebook.result_links.missing_result_ids).toEqual(['estimate', 'other']);
    expect(renderTraceabilityProse(view)).toContain('HUMAN NOTEBOOK NEEDS ATTENTION');
    expect(view.unanswerable.some(row => row.clause === 'current results explained in the human notebook')).toBe(true);
    let output = '';
    const io = { cwd: root, stdout: (text: string) => { output += text; }, stderr: () => {} };
    const before = fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8');
    expect(await runCli(['notebook', 'check', '--result', 'estimate', '--json'], io)).toBe(1);
    expect(JSON.parse(output).missing_result_ids).toEqual(['estimate']);
    expect(fs.readFileSync(path.join(root, 'research_notebook.md'), 'utf8')).toBe(before);
    output = '';
    expect(await runCli(['notebook', 'check', '--result', 'unknown', '--json'], io)).toBe(2);
    expect(JSON.parse(output).status).toBe('unavailable');
    write(before + '\n[Evidence](docs/estimate.md)\n');
    output = '';
    expect(await runCli(['notebook', 'check', '--result', 'estimate', '--json'], io)).toBe(0);
    expect(JSON.parse(output).status).toBe('linked');
    fs.writeFileSync(path.join(root, 'docs/other.md'), 'Changed after registration.');
    output = '';
    expect(await runCli(['notebook', 'check', '--result', 'estimate', '--json'], io)).toBe(0);
    output = '';
    expect(await runCli(['notebook', 'check', '--result', 'other', '--json'], io)).toBe(2);
    output = '';
    expect(await runCli(['notebook', 'check', '--json'], io)).toBe(2);
  });
});
