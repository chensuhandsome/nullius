import { createHash } from 'crypto';

import { invalidParams, PaperSummarySchema } from '@nullius/shared';

import * as api from '../../api/client.js';
import type { SearchResult } from '../../api/client.js';
import { BudgetTrackerV1, writeOutputDiagnosticsArtifact } from '../diagnostics.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import {
  OutputBatch,
  outputArtifactRef,
  resolveOutputDir,
  type OutputArtifactRef,
} from '../outputDir.js';

type SearchExportFormatV1 = 'jsonl' | 'json';

export interface InspireSearchExportMetaV1 {
  version: 1;
  generated_at: string;
  output_dir: string;
  query: string;
  sort?: string;
  page_size: number;
  max_results: number;
  output_format: SearchExportFormatV1;
  total: number;
  exported: number;
  pages_fetched: number;
  has_more: boolean;
  next_url?: string;
  warnings: string[];
  artifacts: {
    export_path: string;
    meta_path: string;
    diagnostics_path: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function makeArtifactNames(params: {
  key_hash: string;
  output_format: SearchExportFormatV1;
  artifact_name?: string;
  meta_artifact_name?: string;
}): { exportName: string; metaName: string; diagnosticsName: string } {
  const ext = params.output_format === 'jsonl' ? 'jsonl' : 'json';
  return {
    exportName: params.artifact_name ?? `inspire_search_export_${params.key_hash}.${ext}`,
    metaName: params.meta_artifact_name ?? `inspire_search_export_${params.key_hash}_meta.json`,
    diagnosticsName: `inspire_search_export_${params.key_hash}_diagnostics.json`,
  };
}

function preprocessQuery(query: string): string {
  return query.replace(/\ba:["']([^"']+)["']/gi, 'a:$1');
}

/**
 * A search page from the cache or INSPIRE, checked field by field before any
 * record is written; anything malformed aborts the export (fail-fast).
 */
function searchPage(response: unknown, operation: string): SearchResult {
  const malformed = (detail: string): never => {
    throw invalidParams(`INSPIRE ${operation} returned a malformed search page (fail-fast): ${detail}`, { operation });
  };
  const page = response as Record<string, unknown> | null;
  if (!page || typeof page !== 'object' || Array.isArray(page)) malformed('not an object');
  const { total, papers, has_more: hasMore, next_url: nextUrl, warning } = page as Record<string, unknown>;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) malformed('total is not a non-negative integer');
  if (!Array.isArray(papers)) malformed('papers is not an array');
  // INSPIRE pages carry has_more exactly when they carry a next_url.
  if (typeof hasMore !== 'boolean') malformed('has_more is not a boolean');
  if (hasMore && (typeof nextUrl !== 'string' || nextUrl.length === 0)) malformed('has_more without a next_url');
  if (!hasMore && nextUrl !== undefined) malformed('next_url without has_more');
  if (warning !== undefined && typeof warning !== 'string') malformed('warning is not a string');
  (papers as unknown[]).forEach((paper, index) => {
    if (!PaperSummarySchema.safeParse(paper).success) malformed(`papers[${index}] is not a paper record`);
  });
  return response as SearchResult;
}

type ExternalApiCallIndexItemV1 = {
  version: 1;
  namespace: string;
  operation: string;
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  request_path: string;
  response_path: string;
};

/**
 * Export an INSPIRE search, page by page, into the caller's output directory:
 * the records (jsonl/json), a meta record, a budget/warning record, and the
 * external API requests and responses the export was built from.
 */
export async function hepInspireSearchExport(params: {
  output_dir: string;
  query: string;
  sort?: string;
  size: number;
  max_results: number;
  output_format: SearchExportFormatV1;
  artifact_name?: string;
  meta_artifact_name?: string;
  budget_hints?: {
    size_provided?: boolean;
    max_results_provided?: boolean;
  };
}): Promise<{
  output_dir: string;
  artifacts: OutputArtifactRef[];
  export_path: string;
  meta_path: string;
  summary: {
    total: number;
    exported: number;
    pages_fetched: number;
    has_more: boolean;
    warnings_total: number;
    warnings: string[];
  };
}> {
  const output = resolveOutputDir(params.output_dir);

  const artifacts: OutputArtifactRef[] = [];
  const warnings: string[] = [];
  const budget = new BudgetTrackerV1();

  const pageSize = budget.resolveInt({
    key: 'inspire.search_export.page_size',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'size',
    tool_value: params.size,
    tool_value_present: params.budget_hints?.size_provided ?? true,
    env_var: 'HEP_BUDGET_INSPIRE_SEARCH_PAGE_SIZE',
    default_value: 1000,
    min: 1,
    max: 1000,
  });

  const maxResults = budget.resolveInt({
    key: 'inspire.search_export.max_results',
    dimension: 'breadth',
    unit: 'items',
    arg_path: 'max_results',
    tool_value: params.max_results,
    tool_value_present: params.budget_hints?.max_results_provided ?? true,
    env_var: 'HEP_BUDGET_INSPIRE_SEARCH_MAX_RESULTS',
    default_value: 10_000,
    min: 1,
    max: 10_000,
  });

  const outputFormat: SearchExportFormatV1 = params.output_format;
  const query = preprocessQuery(params.query);

  const namingMaterial = JSON.stringify({
    query,
    sort: params.sort ?? null,
    page_size: pageSize,
    max_results: maxResults,
    output_format: outputFormat,
  });
  const exportKeyHash = sha256Hex(namingMaterial).slice(0, 16);

  const { exportName, metaName, diagnosticsName } = makeArtifactNames({
    key_hash: exportKeyHash,
    output_format: outputFormat,
    artifact_name: params.artifact_name,
    meta_artifact_name: params.meta_artifact_name,
  });

  let exported = 0;
  let received = 0;
  let pagesFetched = 0;
  // INSPIRE's total may grow while an export pages through it; the largest
  // reported value is the one used throughout.
  let largestTotal = 0;
  let nextUrl: string | undefined;
  let truncatedMidPage = false;
  const externalApiCalls: ExternalApiCallIndexItemV1[] = [];
  const visitedUrls = new Set<string>();
  const paginationContradiction = (detail: string): never => {
    throw invalidParams(`INSPIRE search pagination is inconsistent (fail-fast): ${detail}`, { query, pages_fetched: pagesFetched });
  };

  const externalApiCallsName = `external_api_calls_inspire_search_export_${exportKeyHash}.json`;
  const batch = new OutputBatch(output);
  batch.reserve({
    artifact_name: exportName,
    meta_artifact_name: metaName,
    diagnostics: diagnosticsName,
    external_api_calls: externalApiCallsName,
  });

  try {
    const exportFile = batch.stream(exportName, outputFormat === 'jsonl' ? 'application/x-ndjson' : 'application/json');
    const out = exportFile.stream;
    let wroteAny = false;

    const writeItem = (paper: unknown) => {
      if (outputFormat === 'jsonl') {
        out.write(`${JSON.stringify(paper)}\n`);
        return;
      }

      if (wroteAny) out.write(',\n');
      out.write(JSON.stringify(paper));
      wroteAny = true;
    };

    const fetchPage = async (operation: 'search' | 'searchByUrl', request: Record<string, unknown>, fetch: () => Promise<unknown>) => {
      const cached = await cachedExternalApiJsonCall({
        batch,
        namespace: 'inspire',
        operation,
        request,
        fetch,
        validate: response => searchPage(response, operation),
      });
      const [requestRef, responseRef] = cached.artifacts;
      externalApiCalls.push({
        version: 1,
        namespace: 'inspire',
        operation,
        request_hash: cached.request_hash,
        cache_hit: cached.cache_hit,
        cached_response_uri: cached.cached_response_uri,
        request_path: requestRef.path,
        response_path: responseRef.path,
      });
      pagesFetched += 1;
      const page = cached.response;
      largestTotal = Math.max(largestTotal, page.total);
      if (page.warning) {
        warnings.push(page.warning);
        budget.warn({ severity: 'warning', code: 'inspire_api_limit', message: page.warning });
      }
      // Count every record INSPIRE returned, before max_results cuts a page:
      // more records than the reported total means pages repeated.
      received += page.papers.length;
      if (received > largestTotal) {
        paginationContradiction(`INSPIRE returned ${received} records but reported a total of ${largestTotal}`);
      }
      if (page.papers.length === 0 && page.has_more) paginationContradiction('an empty page claims that more records follow');
      return page;
    };

    if (outputFormat === 'json') {
      out.write('[\n');
    }

    let pageRes = await fetchPage(
      'search',
      { query, sort: params.sort ?? null, size: pageSize, page: 1 },
      () => api.search(query, { sort: params.sort, size: pageSize, page: 1 }),
    );
    while (true) {
      const remaining = maxResults - exported;
      const page = pageRes.papers.slice(0, Math.max(0, remaining));
      for (const paper of page) {
        writeItem(paper);
        exported += 1;
      }
      if (pageRes.papers.length > page.length) {
        truncatedMidPage = true;
      }

      nextUrl = pageRes.next_url;

      if (exported >= maxResults) break;
      if (!pageRes.has_more) break;
      if (!nextUrl) break;

      const url = nextUrl;
      if (visitedUrls.has(url)) paginationContradiction('a page points back to an earlier page');
      visitedUrls.add(url);
      pageRes = await fetchPage('searchByUrl', { url }, () => api.searchByUrl(url));
    }

    if (outputFormat === 'json') {
      out.write('\n]\n');
    }

    const exportRef = await exportFile.finish();
    const total = largestTotal;
    const hasMore = total > exported;
    // A next-page URL continues the export only if this export ended on a
    // page boundary; after cutting inside a page it would skip the rest of
    // that page, so none is given.
    const resumeUrl = hasMore && !truncatedMidPage ? nextUrl : undefined;
    if (hasMore && resumeUrl === undefined) {
      const msg = 'More records exist than were exported and no continuation URL is given (the export stopped inside a page, or INSPIRE offered no next page); rerun with a larger max_results.';
      warnings.push(msg);
      budget.warn({ severity: 'warning', code: 'no_continuation_url', message: msg });
    }

    if (total > exported) {
      const msg = `INSPIRE search export truncated at max_results=${maxResults} (total=${total}, exported=${exported}).`;
      warnings.push(msg);
      budget.recordHit({
        key: 'inspire.search_export.max_results',
        dimension: 'breadth',
        unit: 'items',
        limit: maxResults,
        observed: total,
        action: 'truncate',
        message: msg,
        data: { total, exported, truncated_mid_page: truncatedMidPage },
      });
    }

    if (truncatedMidPage) {
      const msg = 'Export stopped mid-page due to max_results; rerun with a higher max_results to avoid partial pagination.';
      warnings.push(msg);
      budget.warn({ severity: 'warning', code: 'pagination_mid_page_truncation', message: msg });
    }

    artifacts.push(exportRef);

    const externalApiCallsRef = batch.json(externalApiCallsName, {
      version: 1,
      generated_at: nowIso(),
      output_dir: output.relative,
      calls: externalApiCalls,
      stats: {
        calls_total: externalApiCalls.length,
        cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
        cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
      },
    });
    artifacts.push(externalApiCallsRef);

    const diag = writeOutputDiagnosticsArtifact({
      batch,
      operation: 'inspire_search_export',
      artifact_name: diagnosticsName,
      ...budget.snapshot(),
    });
    artifacts.push(diag.ref);

    const metaPayload: InspireSearchExportMetaV1 = {
      version: 1,
      generated_at: nowIso(),
      output_dir: output.relative,
      query,
      sort: params.sort,
      page_size: pageSize,
      max_results: maxResults,
      output_format: outputFormat,
      total,
      exported,
      pages_fetched: pagesFetched,
      has_more: hasMore,
      next_url: resumeUrl,
      warnings,
      artifacts: {
        export_path: exportRef.path,
        meta_path: outputArtifactRef(output, metaName, 'application/json').path,
        diagnostics_path: diag.ref.path,
      },
    };

    const metaRef = batch.json(metaName, metaPayload);
    artifacts.push(metaRef);

    await batch.publish();

    return {
      output_dir: output.relative,
      artifacts,
      export_path: exportRef.path,
      meta_path: metaRef.path,
      summary: {
        total,
        exported,
        pages_fetched: pagesFetched,
        has_more: hasMore,
        warnings_total: warnings.length,
        warnings: warnings.slice(0, 20),
      },
    };
  } catch (err) {
    batch.discard();
    throw err;
  }
}
