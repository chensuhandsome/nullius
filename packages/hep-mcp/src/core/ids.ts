import { randomUUID } from 'crypto';

function randomSuffix(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function newSessionId(): string {
  return `sess_${Date.now()}_${randomSuffix()}`;
}
