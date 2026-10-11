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
import pLimit from 'p-limit';

import * as inspireApi from '../../api/client.js';
import { cachedExternalApiJsonCall } from '../cache/externalApiCache.js';
import { paperRecid } from '../inspire/resolveIdentifiers.js';
import { BudgetTrackerV1, writeOutputDiagnosticsArtifact } from '../diagnostics.js';
import { OutputBatch, resolveOutputDir, type OutputArtifactRef } from '../outputDir.js';

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
  const mapName = 'zotero_map_v1.json';
  const externalCallsName = 'external_api_calls_inspire_zotero_import_v1.json';
  const diagnosticsName = 'zotero_import_diagnostics.json';
  const batch = new OutputBatch(output);
  batch.reserve({ map: mapName, external_api_calls: externalCallsName, diagnostics: diagnosticsName });
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
  // A request repeated in this call is made once, so it is indexed once.
  const indexedRequests = new Set<string>();
  const indexCall = (entry: (typeof externalApiCalls)[number]): void => {
    const key = `${entry.namespace}:${entry.operation}:${entry.request_hash}`;
    if (indexedRequests.has(key)) return;
    indexedRequests.add(key);
    externalApiCalls.push(entry);
  };

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
    if (!Array.isArray(listRes.data)) {
      throw invalidParams('Zotero returned a malformed collection listing (fail-fast): not a list', { collection_key: collectionKey });
    }
    listRes.data.forEach((it, index) => {
      if (!isRecord(it) || typeof it.key !== 'string') {
        throw invalidParams(`Zotero returned a malformed collection listing (fail-fast): entry ${index} has no item key`, {
          collection_key: collectionKey,
        });
      }
      itemKeySet.add(normalizeZoteroKey(it.key, 'item_keys'));
    });
  }

  const itemKeys = Array.from(itemKeySet);
  if (itemKeys.length === 0) {
    throw invalidParams(collectionKey
      ? 'The Zotero collection lists no top-level items in the requested range; nothing to map'
      : 'Either collection_key or item_keys must be provided');
  }

  // Once any item fails, no further item starts; the call waits for the ones
  // already running to settle before it reports the failure, so nothing is
  // still calling Zotero or INSPIRE, or recording, after the call returns.
  const limiter = pLimit(concurrency);
  let stopped = false;
  // A failing request stops the queue at once, before its sibling request settles.
  const stopOnFailure = <T>(request: Promise<T>): Promise<T> => request.catch(error => {
    stopped = true;
    throw error;
  });
  const mapItem = async (itemKey: string) => {
    const [itemSettled, childSettled] = await Promise.allSettled([
      stopOnFailure(zoteroGetJson<Record<string, unknown>>(`/users/0/items/${encodeURIComponent(itemKey)}`)),
      stopOnFailure(zoteroGetJson<unknown[]>(`/users/0/items/${encodeURIComponent(itemKey)}/children`)),
    ]);
    if (itemSettled.status === 'rejected') throw itemSettled.reason;
    if (childSettled.status === 'rejected') throw childSettled.reason;
    const itemRes = itemSettled.value;
    const childRes = childSettled.value;

    if (!Array.isArray(childRes.data)) {
      throw invalidParams('Zotero returned a malformed child-item listing (fail-fast): not a list', { item_key: itemKey });
    }
    // Every child entry is checked, so none is skipped silently by the attachment parser.
    childRes.data.forEach((child, index) => {
      const ok = isRecord(child)
        && typeof child.key === 'string' && child.key.trim().length > 0
        && isRecord(child.data) && typeof child.data.itemType === 'string';
      if (!ok) {
        throw invalidParams(`Zotero returned a malformed child-item listing (fail-fast): entry ${index} lacks an item key, data or item type`, {
          item_key: itemKey,
        });
      }
    });
    const attachments = parseAttachmentSummaries(childRes.data);

    const ids = extractZoteroItemIdentifiers(itemRes.data);
    const resolvedRecid = await (async () => {
      if (ids.inspire_recid) {
        return { recid: ids.inspire_recid, method: 'inspire_recid', confidence: 1 };
      }
      if (ids.doi) {
        const doi = ids.doi;
        const cached = await cachedExternalApiJsonCall({
          batch,
          namespace: 'inspire',
          operation: 'getByDoi',
          request: { doi },
          fetch: () => inspireApi.getByDoi(doi),
          validate: response => paperRecid(response, 'getByDoi'),
        });
        const [requestRef, responseRef] = cached.artifacts;
        indexCall({
          version: 1,
          namespace: 'inspire',
          operation: 'getByDoi',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_path: requestRef.path,
          response_path: responseRef.path,
        });
        const recid = cached.response;
        return recid === undefined ? null : { recid, method: 'doi', confidence: 1 };
      }
      if (ids.arxiv_id) {
        const arxivId = ids.arxiv_id;
        const cached = await cachedExternalApiJsonCall({
          batch,
          namespace: 'inspire',
          operation: 'getByArxiv',
          request: { arxiv_id: arxivId },
          fetch: () => inspireApi.getByArxiv(arxivId),
          validate: response => paperRecid(response, 'getByArxiv'),
        });
        const [requestRef, responseRef] = cached.artifacts;
        indexCall({
          version: 1,
          namespace: 'inspire',
          operation: 'getByArxiv',
          request_hash: cached.request_hash,
          cache_hit: cached.cache_hit,
          cached_response_uri: cached.cached_response_uri,
          request_path: requestRef.path,
          response_path: responseRef.path,
        });
        const recid = cached.response;
        return recid === undefined ? null : { recid, method: 'arxiv', confidence: 1 };
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
  };
  const settled = await Promise.allSettled(itemKeys.map(itemKey => limiter(async () => {
    if (stopped) return null;
    try {
      return await mapItem(itemKey);
    } catch (error) {
      stopped = true;
      throw error;
    }
  })));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) {
    throw batch.discard(failed.reason);
  }
  const perItem = settled.map(result => {
    if (result.status !== 'fulfilled' || result.value === null) throw new Error('Internal: a Zotero item was skipped without a failure');
    return result.value;
  });

  const items = perItem.map(r => r.item);
  const resolved = perItem.filter(r => r.resolved_recid !== null).length;
  const attachmentsTotal = perItem.reduce((acc, r) => acc + r.attachments_total, 0);
  const pdfAttachmentsTotal = perItem.reduce((acc, r) => acc + r.pdf_attachments_total, 0);

  try {
    const mapRef = batch.json(mapName, {
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

    const externalCallsRef = batch.json(externalCallsName, {
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
      batch,
      operation: 'hep_import_from_zotero',
      artifact_name: diagnosticsName,
      ...budget.snapshot(),
    });
    artifacts.push(diag.ref);

    await batch.publish();
  } catch (error) {
    throw batch.discard(error);
  }

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
