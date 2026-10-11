import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { invalidParams, McpError, upstreamError, writeBytesAtomicDurable } from '@nullius/shared';

import { ensureDir, getCacheDir } from '../../data/dataDir.js';
import { assertSafePathSegment } from '../paths.js';
import { EXTERNAL_API_SUBDIR, outputArtifactRef, type OutputArtifactRef, type OutputBatch } from '../outputDir.js';

type ExternalApiCacheEntryV1 = {
  version: 1;
  created_at: string;
  namespace: string;
  operation: string;
  request_hash: string;
  request: unknown;
  response: unknown;
};

function nowIso(): string {
  return new Date().toISOString();
}

function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'number' || t === 'boolean') return JSON.stringify(value);
  if (t === 'bigint') return JSON.stringify(String(value));
  if (t === 'undefined') return 'undefined';
  if (t === 'function' || t === 'symbol') return JSON.stringify(String(value));

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }

  return JSON.stringify(String(value));
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Promise-wrapped delegation to the shared durable primitive. The previous
// implementation did tmp + rename WITHOUT fsync (cache files vulnerable to
// power-loss truncation between write and the next OS flush). The sync
// writeBytesAtomicDurable adds file fsync + parent-dir fsync; we keep the
// async signature so callers don't need to be rewritten.
//
// Trade-off vs the prior `fs.promises.writeFile + fs.promises.rename`: the
// sync primitive blocks the event loop for the write + 2 fsyncs (cache
// payloads are bounded JSON blobs, so the window is small). A throw inside
// the async body rejects the returned Promise, so callers' existing
// try/await/catch continue to observe write failures identically.
async function atomicWriteFile(params: { file_path: string; bytes: Uint8Array }): Promise<void> {
  writeBytesAtomicDurable(params.file_path, Buffer.from(params.bytes));
}

function safeCacheSegment(raw: string, what: string): string {
  const trimmed = raw.trim();
  assertSafePathSegment(trimmed, what);
  return trimmed;
}

function externalApiCacheEntryPath(params: { namespace: string; operation: string; request_hash: string }): string {
  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');
  const hash = params.request_hash;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    throw invalidParams('Internal: request_hash must be a sha256 hex string', { request_hash: hash });
  }

  const cacheRoot = getCacheDir();
  ensureDir(cacheRoot);
  const dir = path.join(cacheRoot, 'external_api_v1', namespace, operation, hash.slice(0, 2).toLowerCase());
  ensureDir(dir);
  return path.join(dir, `${hash}.json`);
}

function defaultArtifactName(prefix: string, params: { namespace: string; operation: string; request_hash: string }): string {
  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');
  return `${EXTERNAL_API_SUBDIR}/${prefix}_${namespace}_${operation}_${params.request_hash}.json`;
}

/**
 * The identity of one external API request: its hash and the output names
 * of its request and response records.
 */
export function describeExternalApiRequest(params: { namespace: string; operation: string; request: unknown }): {
  namespace: string;
  operation: string;
  request_hash: string;
  request_name: string;
  response_name: string;
} {
  const namespace = safeCacheSegment(params.namespace, 'namespace');
  const operation = safeCacheSegment(params.operation, 'operation');
  const requestHash = sha256Hex(stableStringify({
    version: 1,
    namespace,
    operation,
    request: params.request ?? null,
  }));
  return {
    namespace,
    operation,
    request_hash: requestHash,
    request_name: defaultArtifactName('external_api_request', { namespace, operation, request_hash: requestHash }),
    response_name: defaultArtifactName('external_api_response', { namespace, operation, request_hash: requestHash }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * One external API call through the shared response cache. The request and
 * the response INSPIRE (or the cache) returned are recorded in the caller's
 * output batch under `external_api/`; the response record keeps the raw
 * response, not the caller's reading of it. A request repeated within one
 * call, concurrently or not, is made, validated and recorded once, and
 * every repeat shares the outcome.
 *
 * `validate` checks the response for the fields the caller uses and returns
 * what the caller needs from it. A fresh response is validated before it
 * enters the cache, so a malformed one is never cached; a cached response
 * that fails validation, or a cache entry that is not a well-formed entry for
 * exactly this request, aborts the call with an error naming the cache entry
 * to remove. Both record names are checked before the cache is read or the
 * provider is asked.
 */
export async function cachedExternalApiJsonCall<T>(params: {
  batch: OutputBatch;
  namespace: string;
  operation: string;
  request: unknown;
  fetch: () => Promise<unknown>;
  validate: (response: unknown) => T;
  tool?: { name: string; args: Record<string, unknown> };
}): Promise<{
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  artifacts: OutputArtifactRef[];
  response: T;
}> {
  const described = describeExternalApiRequest(params);
  return params.batch.once(
    `external_api:${described.namespace}:${described.operation}:${described.request_hash}`,
    () => performCachedCall(params, described),
  );
}

async function performCachedCall<T>(
  params: {
    batch: OutputBatch;
    request: unknown;
    fetch: () => Promise<unknown>;
    validate: (response: unknown) => T;
    tool?: { name: string; args: Record<string, unknown> };
  },
  described: ReturnType<typeof describeExternalApiRequest>,
): Promise<{
  request_hash: string;
  cache_hit: boolean;
  cached_response_uri: string;
  artifacts: OutputArtifactRef[];
  response: T;
}> {
  const batch = params.batch;
  const output = batch.out;
  const { namespace, operation, request_hash: requestHash, request_name: requestArtifactName, response_name: responseArtifactName } = described;
  const request = params.request ?? null;
  const retryAfterRemoving = params.tool
    ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after removing the corrupted cache entry (manual) (fail-fast).' }]
    : [];

  batch.assertFree(requestArtifactName);
  batch.assertFree(responseArtifactName);

  const cachePath = (() => {
    try {
      return externalApiCacheEntryPath({ namespace, operation, request_hash: requestHash });
    } catch (err) {
      throw invalidParams('Failed to resolve external API cache path (fail-fast)', {
        output_dir: output.relative,
        namespace,
        operation,
        request_hash: requestHash,
        error: err instanceof Error ? err.message : String(err),
        next_actions: [
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after fixing cache directory permissions/disk space (fail-fast).' }] : []),
        ],
      });
    }
  })();
  const cachedResponseUri = pathToFileURL(cachePath).toString();
  const corrupted = (message: string, error?: unknown): McpError => invalidParams(message, {
    output_dir: output.relative,
    namespace,
    operation,
    request_hash: requestHash,
    cached_response_uri: cachedResponseUri,
    cache_path: cachePath,
    ...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
    next_actions: retryAfterRemoving,
  });

  batch.json(requestArtifactName, {
    version: 1,
    generated_at: nowIso(),
    namespace,
    operation,
    request_hash: requestHash,
    request,
  });
  const requestRef = outputArtifactRef(output, requestArtifactName, 'application/json');

  let cacheHit = false;
  let raw: unknown;
  let response: T;

  if (fs.existsSync(cachePath)) {
    let cached: unknown;
    try {
      cached = JSON.parse(await fs.promises.readFile(cachePath, 'utf-8'));
    } catch (err) {
      throw corrupted('External API cache entry is not valid JSON (fail-fast)', err);
    }

    // The entry must be for exactly this request: its recorded request is
    // compared, not only the hash field it carries.
    if (
      !isRecord(cached)
      || cached.version !== 1
      || cached.request_hash !== requestHash
      || cached.namespace !== namespace
      || cached.operation !== operation
      || !Object.prototype.hasOwnProperty.call(cached, 'request')
      || stableStringify(cached.request) !== stableStringify(request)
      || !Object.prototype.hasOwnProperty.call(cached, 'response')
    ) {
      throw corrupted('External API cache entry is not an entry for this request (fail-fast)');
    }

    raw = cached.response;
    try {
      response = params.validate(raw);
    } catch (err) {
      throw corrupted('Cached external API response is malformed (fail-fast)', err);
    }
    cacheHit = true;
  } else {
    try {
      raw = await params.fetch();
    } catch (err) {
      // The provider boundary: whatever the remote call raised is a provider
      // failure. Callers may report these per item; any other error (a
      // refused output write, a corrupted cache entry, a programming fault)
      // keeps its own type and aborts the call.
      if (err instanceof McpError) throw err;
      throw upstreamError(`${namespace}.${operation} request failed: ${err instanceof Error ? err.message : String(err)}`, {
        namespace,
        operation,
        request_hash: requestHash,
      });
    }

    // A malformed response aborts the call before it is cached.
    response = params.validate(raw);

    const entry: ExternalApiCacheEntryV1 = {
      version: 1,
      created_at: nowIso(),
      namespace,
      operation,
      request_hash: requestHash,
      request,
      response: raw,
    };

    try {
      await atomicWriteFile({ file_path: cachePath, bytes: Buffer.from(JSON.stringify(entry, null, 2), 'utf-8') });
    } catch (err) {
      throw invalidParams('External API cache write failed (fail-fast)', {
        output_dir: output.relative,
        namespace,
        operation,
        request_hash: requestHash,
        cached_response_uri: cachedResponseUri,
        cache_path: cachePath,
        error: err instanceof Error ? err.message : String(err),
        next_actions: [
          ...(params.tool ? [{ tool: params.tool.name, args: params.tool.args, reason: 'Retry after resolving cache directory IO failures (fail-fast).' }] : []),
        ],
      });
    }
  }

  batch.json(responseArtifactName, {
    version: 1,
    generated_at: nowIso(),
    namespace,
    operation,
    request_hash: requestHash,
    request_path: requestRef.path,
    cache_hit: cacheHit,
    cached_response_uri: cachedResponseUri,
    response: raw ?? null,
  });
  const responseRef = outputArtifactRef(output, responseArtifactName, 'application/json');

  return {
    request_hash: requestHash,
    cache_hit: cacheHit,
    cached_response_uri: cachedResponseUri,
    artifacts: [requestRef, responseRef],
    response,
  };
}
