/**
 * Handler for openalex_content tool.
 *
 * Downloads full-text PDF or TEI-XML from content.openalex.org with:
 * - Streaming to a freshly created staging file (atomic write via rename)
 * - MIME type validation
 * - Size limit enforcement via Content-Length header
 * - Path guard (no symlink escape from data dir)
 * - Redirect limit enforcement
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { z } from 'zod';
import { commitStagedDurable, fileIdentityOfFd, invalidParams, unlinkIfSameFile, upstreamError } from '@nullius/shared';
import type { FileIdentity } from '@nullius/shared';
import type { OpenAlexContentSchema } from '../tools/schemas.js';
import { openalexFetchFullUrl, getCostSummary, getResponseMeta } from './rateLimiter.js';
import { getDataDir } from './client.js';
import { guardPath } from './pathGuard.js';
import { detectIdentifier } from './identifiers.js';

const CONTENT_BASE_URL = 'https://content.openalex.org';
const ACCEPTED_MIME_PDF = ['application/pdf'];
const ACCEPTED_MIME_TEI = ['application/xml', 'text/xml', 'application/tei+xml'];

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeWorkId(rawId: string): string {
  const detected = detectIdentifier(rawId);
  if (detected?.type === 'openalex') return detected.normalized;
  if (detected?.type === 'openalex_url') {
    return detected.normalized.split('/').pop() ?? rawId;
  }
  // For DOIs etc., use the raw form — content API may accept DOI-based lookup
  return rawId;
}

export async function handleContent(
  args: z.output<typeof OpenAlexContentSchema>,
): Promise<{
  work_id: string;
  type: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  uri: string;
  cost: ReturnType<typeof getCostSummary>;
  _meta: ReturnType<typeof getResponseMeta>;
}> {
  const workId = normalizeWorkId(args.work_id);
  const ext = args.type === 'tei' ? 'tei.xml' : 'pdf';
  const contentPath = `/${args.type}/${encodeURIComponent(workId)}`;
  const url = `${CONTENT_BASE_URL}${contentPath}`;

  // Resolve output directory; the default one is held to the data dir too, so
  // a `content` link that leads out of it is refused like an out_dir would be.
  const outDirResolved = args.out_dir
    ? guardPath(getDataDir(), path.resolve(args.out_dir), 'out_dir')
    : guardPath(getDataDir(), path.join(getDataDir(), 'content'), 'content dir');
  ensureDir(outDirResolved);

  // Safe filename: workId with non-alphanumeric chars replaced
  const safeId = workId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
  const fileName = `${safeId}.${ext}`;
  const destPath = guardPath(outDirResolved, path.join(outDirResolved, fileName), 'output file');
  // Fresh staging name beside the destination, so the rename stays within one
  // directory and no entry left at a predictable name is reused.
  const tmpPath = `${destPath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;

  // Fetch with HEAD-based size check first
  const response = await openalexFetchFullUrl(url);
  if (!response.ok) {
    if (response.status === 404) throw invalidParams(`Content not available for work: ${workId}`);
    throw upstreamError(`OpenAlex content fetch failed: HTTP ${response.status}`);
  }

  // MIME validation
  const contentType = response.headers.get('content-type') ?? '';
  const mimeBase = contentType.split(';')[0].trim().toLowerCase();
  const accepted = args.type === 'pdf' ? ACCEPTED_MIME_PDF : ACCEPTED_MIME_TEI;
  if (!accepted.some(m => mimeBase === m || mimeBase.startsWith(m))) {
    throw upstreamError(
      `Unexpected content type for ${args.type}: ${contentType}. ` +
      `Expected one of: ${accepted.join(', ')}`,
    );
  }

  // Size check via Content-Length header
  const contentLength = response.headers.get('content-length');
  if (contentLength != null) {
    const bytes = parseInt(contentLength, 10);
    const limitBytes = args.max_size_mb * 1024 * 1024;
    if (Number.isFinite(bytes) && bytes > limitBytes) {
      throw invalidParams(
        `Content-Length (${(bytes / 1024 / 1024).toFixed(1)} MB) exceeds max_size_mb (${args.max_size_mb})`,
      );
    }
  }

  // Stream response body to temp file
  if (!response.body) throw upstreamError('OpenAlex content response has no body');

  // 'wx' is O_CREAT|O_EXCL: the open fails on any existing entry at tmpPath,
  // a symlink included (whatever it points to), so the bytes can only land in
  // a file created here.
  const fd = fs.openSync(tmpPath, 'wx');
  // Cleanup removes tmpPath only while it still names the file created here
  // (same device and inode); an entry someone else put at that name stays.
  let staged: FileIdentity | undefined;
  const removeStaged = (): void => unlinkIfSameFile(tmpPath, staged);
  let totalBytes = 0;
  const limitBytes = args.max_size_mb * 1024 * 1024;
  try {
    staged = fileIdentityOfFd(fd);
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > limitBytes) {
          throw invalidParams(
            `Download exceeded max_size_mb (${args.max_size_mb}): stopped at ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
          );
        }
        fs.writeSync(fd, Buffer.from(value));
      }
    }
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* best-effort */ }
    removeStaged();
    throw err;
  }
  // A staging file that cannot be closed is not committed.
  try {
    fs.closeSync(fd);
  } catch (err) {
    removeStaged();
    throw err;
  }

  // Commit: rename, then fsync the parent directory. A staging file whose
  // rename failed is removed, since each attempt has its own name and none is
  // reused. Once the rename has returned, the staging name is never touched
  // again, whatever the directory fsync does.
  commitStagedDurable(tmpPath, destPath, removeStaged);

  const uri = `openalex://content/${workId}/${fileName}`;

  return {
    work_id: workId,
    type: args.type,
    file_path: destPath,
    file_size: totalBytes,
    mime_type: mimeBase,
    uri,
    cost: getCostSummary(),
    _meta: getResponseMeta(),
  };
}
