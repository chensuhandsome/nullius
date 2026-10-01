import { describe, expect, it } from 'vitest';
import { compactMessagesForOverflow } from '../src/agent-runner-history-compaction.js';
import type { MessageParam } from '../src/backends/chat-backend.js';

function assertPairedToolMessages(messages: MessageParam[]): void {
  const outstanding = new Set<string>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        expect(message.role).toBe('assistant');
        expect(outstanding.has(block.id)).toBe(false);
        outstanding.add(block.id);
      } else if (block.type === 'tool_result') {
        expect(message.role).toBe('user');
        expect(outstanding.delete(block.tool_use_id)).toBe(true);
      }
    }
  }
  expect([...outstanding]).toEqual([]);
}

describe('overflow history compaction', () => {
  it.each(['start', 'middle', 'end'])('preserves verbatim user constraints at the %s of a long instruction', position => {
    const constraint = 'Read only. Stop after 60 seconds. Do not dispatch a second attempt.';
    const padding = 'Source material to inspect. '.repeat(60);
    const instruction = position === 'start' ? constraint + padding
      : position === 'middle' ? padding + constraint + padding : padding + constraint;
    const steering = 'The export must contain every requested component.';
    const result = compactMessagesForOverflow([
      { role: 'user', content: instruction },
      { role: 'assistant', content: 'Previous analysis. '.repeat(100) },
      { role: 'user', content: [{ type: 'text', text: steering }] },
    ]);
    expect(result).not.toBeNull();
    const texts = result!.messages.flatMap(message => typeof message.content === 'string'
      ? [message.content] : message.content.filter(block => block.type === 'text').map(block => block.text));
    expect(texts).toContain(instruction);
    expect(texts).toContain(steering);
  });

  it('retains or removes each multi-tool exchange as a whole at the history cutoff', () => {
    const result = compactMessagesForOverflow([
      { role: 'user', content: 'Inspect the supplied inputs.' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'old-a', name: 'inspect', input: { item: 'a' } },
        { type: 'tool_use', id: 'old-b', name: 'inspect', input: { item: 'b' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'old-a', content: 'a'.repeat(1000) },
        { type: 'tool_result', tool_use_id: 'old-b', content: 'b'.repeat(1000) },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'recent', name: 'inspect', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'recent', content: 'recent result' }] },
      { role: 'assistant', content: 'Ready to continue.' },
      { role: 'assistant', content: 'The recent turn is complete.' },
    ]);
    expect(result).not.toBeNull();
    assertPairedToolMessages(result!.messages);
    const ids = result!.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []);
    expect(ids).toContain('recent');
    expect(ids).not.toContain('old-a');
    expect(ids).not.toContain('old-b');
  });

  it('does not retry an overflow by deleting the only oversized instruction', () => {
    expect(compactMessagesForOverflow([{ role: 'user', content: 'A required instruction. '.repeat(100) }])).toBeNull();
  });

  it('retains a complete multi-call exchange and labels its excerpts as incomplete evidence', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const messages: MessageParam[] = [
      { role: 'user', content: 'Inspect the inputs.' },
      { role: 'assistant', content: ids.map(id => ({ type: 'tool_use', id, name: 'inspect', input: {} })) },
      { role: 'user', content: ids.map(id => ({ type: 'tool_result' as const, tool_use_id: id, content: `Source ${id}. `.repeat(100) })) },
      { role: 'assistant', content: 'Continue.' },
    ];
    const result = compactMessagesForOverflow(messages)!;
    assertPairedToolMessages(result.messages);
    const results = result.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'tool_result') : []);
    expect(results.map(block => block.tool_use_id)).toEqual(ids);
    expect(results.every(block => block.content.includes('incomplete_excerpt='))).toBe(true);
  });

  it.each([
    { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'missing', content: 'x'.repeat(1000) }] }] },
    { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'missing-result', name: 'inspect', input: {} }] }] },
  ] satisfies Array<{ messages: MessageParam[] }>)('declines recovery for an already malformed or unfinished tool transcript', ({ messages }) => {
    expect(compactMessagesForOverflow(messages)).toBeNull();
  });

  it.each([
    { label: 'intervening assistant message', middle: [{ role: 'assistant', content: 'Intervening explanation.' }] },
    { label: 'intervening user message', middle: [{ role: 'user', content: 'Unrelated steering.' }] },
  ] satisfies Array<{ label: string; middle: MessageParam[] }>)('declines $label before a pending tool result', ({ middle }) => {
    expect(compactMessagesForOverflow([
      { role: 'user', content: 'Read only.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'inspect', input: {} }] },
      ...middle,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'evidence'.repeat(100) }] },
    ])).toBeNull();
  });

  it.each(['before', 'between'])('declines text %s tool results before capsule extraction can repair the ordering', position => {
    const first = { type: 'tool_result' as const, tool_use_id: 'a', content: 'evidence'.repeat(100) };
    const second = { type: 'tool_result' as const, tool_use_id: 'b', content: 'evidence'.repeat(100) };
    const text = { type: 'text' as const, text: 'Read only. Stop after 60 seconds.' };
    expect(compactMessagesForOverflow([
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'inspect', input: {} },
        { type: 'tool_use', id: 'b', name: 'inspect', input: {} },
      ] },
      { role: 'user', content: position === 'before' ? [text, first, second] : [first, text, second] },
    ])).toBeNull();
  });

  it('declines parallel results split across user messages', () => {
    expect(compactMessagesForOverflow([
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'inspect', input: {} },
        { type: 'tool_use', id: 'b', name: 'inspect', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'evidence'.repeat(100) }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: 'evidence'.repeat(100) }] },
    ])).toBeNull();
  });

  it('preserves instructions after all results in a valid user message', () => {
    const instruction = 'Read only. Stop after 60 seconds.';
    const result = compactMessagesForOverflow([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'inspect', input: {} }] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'evidence'.repeat(100) },
        { type: 'text', text: instruction },
      ] },
    ]);
    expect(result).not.toBeNull();
    assertPairedToolMessages(result!.messages);
    expect(result!.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(block => block.type === 'text').map(block => block.text) : [])).toContain(instruction);
  });
});
