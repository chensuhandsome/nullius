import { createHash } from 'crypto';
import {
  extractRecidFromUrl,
  normalizeArxivID,
  invalidParams,
  McpError,
  type IdentifierType,
} from '@nullius/shared';

import * as api from '../../api/client.js';
import { cachedExternalApiJsonCall, describeExternalApiRequest } from '../cache/externalApiCache.js';
import {
  OutputBatch,
  outputArtifactRef,
  resolveOutputDir,
  type OutputArtifactRef,
} from '../outputDir.js';

export type ResolveStatusV1 = 'matched' | 'not_found' | 'error';

export interface ResolveIdentifierItemV1 {
  version: 1;
  input: string;
  normalized: string;
  kind: IdentifierType;
  status: ResolveStatusV1;
  recid?: string;
  doi?: string;
  arxiv_id?: string;
  message?: string;
}

export interface ResolveIdentifiersMetaV1 {
  version: 1;
  generated_at: string;
  output_dir: string;
  total: number;
  matched: number;
  not_found: number;
  errors: number;
  warnings: string[];
  artifacts: {
    mapping_path: string;
    meta_path: string;
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function stripUrlSuffix(input: string): string {
  return input.replace(/[?#].*$/, '');
}

function isLikelyArxivId(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  return (
    /^\d{4}\.\d{4,5}(v\d+)?$/i.test(trimmed)
    || /^[a-z-]+\/\d{7}(v\d+)?$/i.test(trimmed)
  );
}

function makeArtifactNames(params: {
  identifiers: string[];
  artifact_name?: string;
  meta_artifact_name?: string;
}): { mappingName: string; metaName: string } {
  if (params.artifact_name && params.meta_artifact_name) {
    return { mappingName: params.artifact_name, metaName: params.meta_artifact_name };
  }

  const material = JSON.stringify({
    identifiers: params.identifiers.map(s => s.trim()).filter(Boolean),
  });
  const hash = sha256Hex(material).slice(0, 16);
  return {
    mappingName: params.artifact_name ?? `inspire_resolve_identifiers_${hash}.jsonl`,
    metaName: params.meta_artifact_name ?? `inspire_resolve_identifiers_${hash}_meta.json`,
  };
}

function classifyIdentifier(raw: string): { kind: IdentifierType; normalized: string; recid?: string; doi?: string; arxiv_id?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'unknown', normalized: '' };

  const recidFromUrl = extractRecidFromUrl(trimmed);
  if (recidFromUrl) return { kind: 'recid', normalized: recidFromUrl, recid: recidFromUrl };

  if (/^\d+$/.test(trimmed)) return { kind: 'recid', normalized: trimmed, recid: trimmed };

  const doi = (() => {
    const m = trimmed.match(/^https?:\/\/doi\.org\/(10\..+)$/i);
    if (m?.[1]) return stripUrlSuffix(m[1].trim());
    const direct = trimmed.replace(/^doi:/i, '').trim();
    if (direct.startsWith('10.')) return stripUrlSuffix(direct);
    return undefined;
  })();
  if (doi) return { kind: 'doi', normalized: doi, doi };

  const arxiv = (() => {
    const m = trimmed.match(/^https?:\/\/arxiv\.org\/abs\/(.+)$/i);
    const candidate = m?.[1] ? stripUrlSuffix(m[1].trim()) : trimmed;
    const norm = normalizeArxivID(candidate);
    if (!norm) return undefined;
    const cleaned = stripUrlSuffix(norm.trim());
    return isLikelyArxivId(cleaned) ? cleaned : undefined;
  })();
  if (arxiv) return { kind: 'arxiv', normalized: arxiv, arxiv_id: arxiv };

  return { kind: 'unknown', normalized: trimmed };
}

// Only a failed INSPIRE lookup becomes an item-level status: the cached-call
// boundary (cachedExternalApiJsonCall) turns every error raised by the remote
// call into one of these codes. Anything else (a refused or failed write of
// the output files, a corrupted cache entry, an unexpected response, an
// internal fault) aborts the whole call: reporting it per identifier would
// return success while the recorded evidence is missing or wrong.
const PROVIDER_FAILURE_CODES = new Set(['UPSTREAM_ERROR', 'RATE_LIMIT', 'NOT_FOUND']);

function isProviderFailure(err: unknown): boolean {
  return err instanceof McpError && PROVIDER_FAILURE_CODES.has(err.code);
}

/**
 * The recid of an INSPIRE record from the cache or INSPIRE; a response that
 * is not a record aborts the call (fail-fast), a record without a recid
 * resolves to nothing.
 */
export function paperRecid(response: unknown, operation: string): string | undefined {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw invalidParams(`INSPIRE ${operation} returned a non-object response (fail-fast)`, { operation });
  }
  const recid = (response as { recid?: unknown }).recid;
  if (recid === undefined || recid === null) return undefined;
  // INSPIRE recids are non-negative integers, given as a number or a digit string.
  if (typeof recid === 'number' && Number.isSafeInteger(recid) && recid >= 0) return String(recid);
  if (typeof recid === 'string' && /^\d+$/.test(recid)) return recid;
  throw invalidParams(`INSPIRE ${operation} returned a malformed recid (fail-fast)`, { operation });
}

function resolveStatusFromError(err: McpError): { status: ResolveStatusV1; message: string } {
  const notFound = err.code === 'NOT_FOUND'
    || (err.code === 'UPSTREAM_ERROR' && (err.data as { status?: unknown } | undefined)?.status === 404);
  return { status: notFound ? 'not_found' : 'error', message: err.message };
}

/**
 * One INSPIRE lookup made by the call. A lookup whose request failed is
 * listed too, with its request record and the error, and no response.
 */
type ExternalApiCallIndexItemV1 = {
  version: 1;
  namespace: string;
  operation: string;
  request_hash: string;
  outcome: 'response' | 'error';
  cache_hit: boolean;
  cached_response_uri?: string;
  request_path: string;
  response_path: string | null;
  error?: { code: string; message: string };
};

/**
 * Resolve recids, arXiv ids and DOIs to INSPIRE recids, writing the mapping,
 * a meta record and the external API requests and responses used into the
 * caller's output directory.
 */
export async function hepInspireResolveIdentifiers(params: {
  output_dir: string;
  identifiers: string[];
  artifact_name?: string;
  meta_artifact_name?: string;
}): Promise<{
  output_dir: string;
  artifacts: OutputArtifactRef[];
  mapping_path: string;
  meta_path: string;
  summary: {
    total: number;
    matched: number;
    not_found: number;
    errors: number;
    warnings_total: number;
    warnings: string[];
  };
}> {
  const identifiers = params.identifiers.map(s => s.trim());
  const blank = identifiers.flatMap((identifier, index) => (identifier.length === 0 ? [index] : []));
  if (blank.length > 0) {
    throw invalidParams('identifiers must not be blank', { blank_indices: blank });
  }

  const { mappingName, metaName } = makeArtifactNames({
    identifiers,
    artifact_name: params.artifact_name,
    meta_artifact_name: params.meta_artifact_name,
  });

  const output = resolveOutputDir(params.output_dir);
  const mappingRef = outputArtifactRef(output, mappingName, 'application/x-ndjson');
  const metaPath = outputArtifactRef(output, metaName, 'application/json').path;

  const artifacts: OutputArtifactRef[] = [];
  const warnings: string[] = [];
  const externalApiCalls: ExternalApiCallIndexItemV1[] = [];
  // A request repeated in this call is made once, so it is indexed once.
  const indexedRequests = new Set<string>();
  const indexCall = (entry: ExternalApiCallIndexItemV1): void => {
    const key = `${entry.namespace}:${entry.operation}:${entry.request_hash}`;
    if (indexedRequests.has(key)) return;
    indexedRequests.add(key);
    externalApiCalls.push(entry);
  };

  let matched = 0;
  let notFound = 0;
  let errors = 0;

  const indexName = `external_api_calls_inspire_resolve_identifiers_${sha256Hex(JSON.stringify({ identifiers })).slice(0, 16)}.json`;
  const batch = new OutputBatch(output);
  batch.reserve({
    artifact_name: mappingName,
    meta_artifact_name: metaName,
    external_api_calls: indexName,
  });

  // One INSPIRE lookup; the record is validated for its recid before it is
  // cached. A provider failure becomes the item's status; anything else
  // aborts the call.
  const lookup = async (
    operation: 'getPaper' | 'getByDoi' | 'getByArxiv',
    request: Record<string, unknown>,
    fetch: () => Promise<unknown>,
  ): Promise<{ recid?: string } | { failure: McpError }> => {
    const described = describeExternalApiRequest({ namespace: 'inspire', operation, request });
    try {
      const cached = await cachedExternalApiJsonCall({
        batch,
        namespace: 'inspire',
        operation,
        request,
        fetch,
        validate: response => ({ recid: paperRecid(response, operation) }),
      });
      const [requestRef, responseRef] = cached.artifacts;
      indexCall({
        version: 1,
        namespace: 'inspire',
        operation,
        request_hash: cached.request_hash,
        outcome: 'response',
        cache_hit: cached.cache_hit,
        cached_response_uri: cached.cached_response_uri,
        request_path: requestRef.path,
        response_path: responseRef.path,
      });
      return cached.response;
    } catch (err) {
      if (!isProviderFailure(err)) throw err;
      const failure = err as McpError;
      indexCall({
        version: 1,
        namespace: 'inspire',
        operation,
        request_hash: described.request_hash,
        outcome: 'error',
        cache_hit: false,
        request_path: outputArtifactRef(output, described.request_name, 'application/json').path,
        response_path: null,
        error: { code: failure.code, message: failure.message },
      });
      return { failure };
    }
  };

  try {
    const mappingFile = batch.stream(mappingName, 'application/x-ndjson');
    const out = mappingFile.stream;

    for (const input of identifiers) {
      const classified = classifyIdentifier(input);

      const item: ResolveIdentifierItemV1 = {
        version: 1,
        input,
        normalized: classified.normalized,
        kind: classified.kind,
        status: 'not_found',
        recid: classified.recid,
        doi: classified.doi,
        arxiv_id: classified.arxiv_id,
      };

      if (!classified.normalized || classified.kind === 'unknown') {
        item.status = 'not_found';
        item.message = 'unsupported_identifier';
        notFound += 1;
        out.write(`${JSON.stringify(item)}\n`);
        continue;
      }

      let result: { recid?: string } | { failure: McpError } | null = null;
      if (classified.kind === 'recid') {
        const recid = classified.normalized;
        result = await lookup('getPaper', { recid }, () => api.getPaper(recid));
      } else if (classified.kind === 'doi' && classified.doi) {
        const doi = classified.doi;
        result = await lookup('getByDoi', { doi }, () => api.getByDoi(doi));
      } else if (classified.kind === 'arxiv' && classified.arxiv_id) {
        const arxivId = classified.arxiv_id;
        result = await lookup('getByArxiv', { arxiv_id: arxivId }, () => api.getByArxiv(arxivId));
      }

      if (result === null) {
        item.status = 'not_found';
        item.message = 'unsupported_identifier';
      } else if ('failure' in result) {
        const status = resolveStatusFromError(result.failure);
        item.status = status.status;
        item.message = status.message;
      } else {
        // A record without a recid resolves to nothing, whatever was asked.
        item.recid = result.recid;
        item.status = result.recid ? 'matched' : 'not_found';
      }

      if (item.status === 'matched') matched += 1;
      else if (item.status === 'not_found') notFound += 1;
      else errors += 1;

      out.write(`${JSON.stringify(item)}\n`);
    }

    artifacts.push(await mappingFile.finish());

    const externalApiCallsRef = batch.json(indexName, {
      version: 1,
      generated_at: nowIso(),
      output_dir: output.relative,
      calls: externalApiCalls,
      stats: {
        calls_total: externalApiCalls.length,
        failed: externalApiCalls.filter(c => c.outcome === 'error').length,
        cache_hits: externalApiCalls.filter(c => c.cache_hit).length,
        cache_misses: externalApiCalls.filter(c => c.outcome === 'response' && !c.cache_hit).length,
      },
    });
    artifacts.push(externalApiCallsRef);

    const metaPayload: ResolveIdentifiersMetaV1 = {
      version: 1,
      generated_at: nowIso(),
      output_dir: output.relative,
      total: identifiers.length,
      matched,
      not_found: notFound,
      errors,
      warnings,
      artifacts: { mapping_path: mappingRef.path, meta_path: metaPath },
    };

    const metaRef = batch.json(metaName, metaPayload);
    artifacts.push(metaRef);

    await batch.publish();

    return {
      output_dir: output.relative,
      artifacts,
      mapping_path: mappingRef.path,
      meta_path: metaRef.path,
      summary: {
        total: identifiers.length,
        matched,
        not_found: notFound,
        errors,
        warnings_total: warnings.length,
        warnings: warnings.slice(0, 20),
      },
    };
  } catch (err) {
    throw batch.discard(err);
  }
}
