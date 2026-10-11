import { randomUUID } from 'crypto';
import { shortId } from '@nullius/shared';

// proj_ follows the EcosystemID `{prefix}_{opaque}` convention. The opaque
// part is a human-referenced handle id, so it uses a compact shortId (Crockford
// base32 — a strict subset of the EcosystemID opaque charset, so `proj_<id>`
// stays a valid EcosystemID and remains parseable downstream).
export function newProjectId(): string {
  return `proj_${shortId()}`;
}

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function newSessionId(): string {
  return `sess_${Date.now()}_${randomSuffix()}`;
}
