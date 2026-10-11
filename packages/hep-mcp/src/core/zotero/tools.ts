/**
 * Core Zotero tools — thin adapter layer.
 *
 * NEW-R04: Deduplication — canonical Zotero tool implementations live in
 * `@nullius/zotero-mcp/src/zotero/tools.ts`.  This file only contains
 * `hepImportFromZotero` (Zotero items -> INSPIRE recids, written into the
 * caller's output directory) and imports shared helpers from the canonical
 * package.
 */

import { invalidParams } from '@nullius/shared';
import type { Paper } from '@nullius/shared';
import pLimit from 'p-limit';

import * as inspireApi from '../../api/client.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { BudgetTrackerV1, writeOutputDiagnosticsArtifact } from '../diagnostics.js';
import { resolveOutputDir, writeOutputJson, type OutputArtifactRef } from '../outputDir.js';

import {
  zoteroGetJson,
  extractZoteroItemIdentifiers,
  isRecord,
  normalizeZoteroKey,
  parseAttachmentSummaries,
  isPdfAttachment,
} from '@nullius/zotero-mcp/shared/zotero';

export async function hepImportFromZotero(params: {
  output_dir: string;
  collection_key?: string;
  item_keys?: string[];
  limit?: number;
  start?: number;
  concurrency?: number;
  budget_hints?: {
    concurrency_provided?: boolean;
  };
}): Promise<{
  output_dir: string;
  artifacts: OutputArtifactRef[];
  summary: { items_total: number; resolved_recids: number; attachments_total: number; pdf_attachments_total: number };
}> {
  const limit = params.limit ?? 200;
  const start = params.start ?? 0;
  const collectionKey = params.collection_key ? normalizeZoteroKey(params.collection_key, 'collection_key') : undefined;

  const itemKeySet = new Set<string>();
  for (const k of (params.item_keys || [])) {
    itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
  }

  const output = resolveOutputDir(params.output_dir);
  const artifacts: OutputArtifactRef[] = [];
  const budget = new BudgetTrackerV1();
  const externalApiCalls: Array<{
    version: 1;
    namespace: string;
    operation: string;
    request_hash: string;
    cache_hit: boolean;
    cached_response_uri: string;
    request_path: string;
    response_path: string;
  }> = [];

  const concurrency = budget.resolveInt({
    key: 'budget.concurrency',
    dimension: 'budget',
    unit: 'requests',
    arg_path: 'concurrency',
    tool_value: params.concurrency,
    tool_value_present: params.budget_hints?.concurrency_provided ?? params.concurrency !== undefined,
    env_var: 'HEP_BUDGET_CONCURRENCY',
    default_value: 4,
    min: 1,
    max: 16,
  });
  budget.warn({
    severity: 'info',
    code: 'concurrency',
    message: `Zotero import parallelism: concurrency=${concurrency}.`,
    data: { concurrency },
  });

  if (collectionKey) {
    const listRes = await zoteroGetJson<unknown[]>(
      `/users/0/collections/${encodeURIComponent(collectionKey)}/items/top`,
      { limit, start }
    );
    for (const it of Array.isArray(listRes.data) ? listRes.data : []) {
      if (!isRecord(it)) continue;
      const k = it.key;
      if (typeof k !== 'string') continue;
      itemKeySet.add(normalizeZoteroKey(k, 'item_keys'));
    }
  }

  const itemKeys = Array.from(itemKeySet);
  if (itemKeys.length === 0) {
    throw invalidParams('Either collection_key or item_keys must be provided');
  }

  const limiter = pLimit(concurrency);
  const perItem = await Promise.all(
    itemKeys.map(itemKey =>
      limiter(async () => {
        const [itemRes, childRes] = await Promise.all([
          zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(itemKey)}`),
          zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`),
        ]);

        const children = Array.isArray(childRes.data) ? childRes.data : [];
        const attachments = parseAttachmentSummaries(children);

        const ids = extractZoteroItemIdentifiers(itemRes.data);
        const resolvedRecid = await (async () => {
          if (ids.inspire_recid) {
            return { recid: ids.inspire_recid, method: 'inspire_recid', confidence: 1 };
          }
          if (ids.doi) {
            const doi = ids.doi;
            const cached = await cachedExternalApiJsonCall({
              output,
              namespace: 'inspire',
              operation: 'getByDoi',
              request: { doi },
              fetch: () => inspireApi.getByDoi(doi),
            });
            const [requestRef, responseRef] = cached.artifacts;
            externalApiCalls.push({
              version: 1,
              namespace: 'inspire',
              operation: 'getByDoi',
              request_hash: cached.request_hash,
              cache_hit: cached.cache_hit,
              cached_response_uri: cached.cached_response_uri,
              request_path: requestRef.path,
              response_path: responseRef.path,
            });
            const paper = cached.response as unknown as Paper;
            return { recid: paper.recid, method: 'doi', confidence: 1 };
          }
          if (ids.arxiv_id) {
            const arxivId = ids.arxiv_id;
            const cached = await cachedExternalApiJsonCall({
              output,
              namespace: 'inspire',
              operation: 'getByArxiv',
              request: { arxiv_id: arxivId },
              fetch: () => inspireApi.getByArxiv(arxivId),
            });
            const [requestRef, responseRef] = cached.artifacts;
            externalApiCalls.push({
              version: 1,
              namespace: 'inspire',
              operation: 'getByArxiv',
              request_hash: cached.request_hash,
              cache_hit: cached.cache_hit,
              cached_response_uri: cached.cached_response_uri,
              request_path: requestRef.path,
              response_path: responseRef.path,
            });
            const paper = cached.response as unknown as Paper;
            return { recid: paper.recid, method: 'arxiv', confidence: 1 };
          }
          return null;
        })();

        return {
          attachments_total: attachments.length,
          pdf_attachments_total: attachments.filter(isPdfAttachment).length,
          resolved_recid: resolvedRecid,
          item: {
            zotero_item_key: ids.zotero_item_key,
            title: ids.title,
            identifiers: {
              doi: ids.doi,
              arxiv_id: ids.arxiv_id,
              inspire_recid: ids.inspire_recid,
            },
            resolve: resolvedRecid,
            attachments,
            warnings: ids.warnings,
            zotero_meta: {
              item_url: itemRes.meta.url,
              children_url: childRes.meta.url,
            },
          },
        };
      })
    )
  );

  const items = perItem.map(r => r.item);
  const resolved = perItem.filter(r => r.resolved_recid !== null).length;
  const attachmentsTotal = perItem.reduce((acc, r) => acc + r.attachments_total, 0);
  const pdfAttachmentsTotal = perItem.reduce((acc, r) => acc + r.pdf_attachments_total, 0);

  const mapRef = writeOutputJson(output, 'zotero_map_v1.json', {
    version: 1,
    generated_at: new Date().toISOString(),
    output_dir: output.relative,
    source: {
      collection_key: collectionKey,
      list_limit: collectionKey ? limit : undefined,
      list_start: collectionKey ? start : undefined,
      item_keys: itemKeys,
      concurrency,
    },
    items,
  });
  artifacts.push(mapRef);

  const externalCallsRef = writeOutputJson(output, 'external_api_calls_inspire_zotero_import_v1.json', {
    version: 1,
    generated_at: new Date().toISOString(),
    output_dir: output.relative,
    calls: externalApiCalls,
    stats: {
      calls_total: externalApiCalls.length,
      cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
      cache_misses: externalApiCalls.filter(c => !c.cache_hit).length,
    },
  });
  artifacts.push(externalCallsRef);

  const diag = writeOutputDiagnosticsArtifact({
    output,
    operation: 'hep_import_from_zotero',
    artifact_name: 'zotero_import_diagnostics.json',
    ...budget.snapshot(),
  });
  artifacts.push(diag.ref);

  return {
    output_dir: output.relative,
    artifacts,
    summary: {
      items_total: itemKeys.length,
      resolved_recids: resolved,
      attachments_total: attachmentsTotal,
      pdf_attachments_total: pdfAttachmentsTotal,
    },
  };
}
