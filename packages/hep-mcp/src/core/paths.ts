import { invalidParams } from '@nullius/shared';

export function assertSafePathSegment(segment: string, what: string): void {
  if (segment.length === 0) throw invalidParams(`${what} cannot be empty`);
  if (segment.includes('\0')) throw invalidParams(`${what} cannot include null byte`);
  if (segment.includes('/') || segment.includes('\\')) {
    throw invalidParams(`${what} cannot include path separators`);
  }
  if (segment === '.' || segment === '..' || segment.includes('..')) {
    throw invalidParams(`${what} contains unsafe segment`);
  }
}
