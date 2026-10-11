import { describe, expect, it, vi } from 'vitest';
import { HARD_CAP_RESULT_BYTES } from '@nullius/shared';

vi.mock('../../src/tools/research/validateBibliography.js', () => ({
  validateBibliography: vi.fn(),
}));

const { handleToolCall } = await import('../../src/tools/index.js');
const validateBibliography = await import('../../src/tools/research/validateBibliography.js');

const MARKER = /\n\.\.\. \[TRUNCATED, original: (\d+) bytes\]$/;

async function oversizedResult(payload: unknown): Promise<string> {
  vi.mocked(validateBibliography.validateBibliography).mockResolvedValueOnce(payload as never);
  const result = await handleToolCall('inspire_validate_bibliography', { identifier: '1' }, 'full');
  expect(result.isError).toBeFalsy();
  return result.content[0]!.text;
}

describe('oversized tool results are cut by UTF-8 bytes on a character boundary', () => {
  it.each([
    ['multibyte (CJK) text', '中'.repeat(60_000)],
    ['ASCII text', 'x'.repeat(200_000)],
    ['mixed text', 'αβγ—'.repeat(30_000)],
  ])('%s', async (_label, text) => {
    const out = await oversizedResult({ text });
    const match = out.match(MARKER);
    expect(match).not.toBeNull();
    const body = out.slice(0, match!.index);
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThanOrEqual(HARD_CAP_RESULT_BYTES);
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(HARD_CAP_RESULT_BYTES - 4);
    expect(body).not.toContain('�');
    expect(Number(match![1])).toBe(Buffer.byteLength(JSON.stringify({ text }), 'utf-8'));
  });
});
