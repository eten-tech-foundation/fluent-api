import { describe, expect, it, vi } from 'vitest';

import type { BriefingEvent } from './assistant.client';

import { RetainedAssistantGeneration } from './assistant.cache';
import { BtServantClient } from './assistant.client';

const request = { userId: 'fluent_1', message: 'fixture', responseLanguageHint: 'en' };
async function run(events: unknown[], limits = { maxOutputBytes: 1024, maxRetainedBytes: 8192 }) {
  const warn = vi.fn();
  const client = new BtServantClient({
    baseUrl: 'https://bt.invalid',
    engineKey: 'fixture',
    org: 'fluent',
    connectMs: 1000,
    idleMs: 1000,
    totalMs: 1000,
    maxFrameBytes: 4096,
    ...limits,
    warn,
    fetch: async () =>
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')),
  });
  return { events: await Array.fromAsync(client.stream(request)), warn };
}
const progress = (text: string) => ({ type: 'progress', text });
const complete = (text: string) => ({ type: 'complete', response: { responses: [text] } });

describe('authoritative BT replacement operations', () => {
  it('retracts multiple attempts regardless of missing, disagreeing or malformed diagnostic metadata', async () => {
    const result = await run([
      progress('discarded private text'),
      { type: 'retract' },
      progress('second'),
      { type: 'retract', iteration: 'private metadata', chars: -999 },
      { type: 'retract', iteration: 3, chars: 999 },
      progress('final'),
      complete('final'),
    ]);
    expect(result.events).toEqual([
      { type: 'briefing_delta', delta: 'discarded private text' },
      { type: 'briefing_replace', markdown: '' },
      { type: 'briefing_delta', delta: 'second' },
      { type: 'briefing_replace', markdown: '' },
      { type: 'briefing_replace', markdown: '' },
      { type: 'briefing_delta', delta: 'final' },
      { type: 'briefing_complete', markdown: 'final' },
    ]);
    expect(JSON.stringify(result.warn.mock.calls)).not.toContain('private');
  });
  it('repairs a mismatching complete once and logs byte counts without content', async () => {
    const { events, warn } = await run([
      progress('private draft'),
      complete('authoritative final'),
    ]);
    expect(events).toEqual([
      { type: 'briefing_delta', delta: 'private draft' },
      { type: 'briefing_replace', markdown: 'authoritative final' },
      { type: 'briefing_complete', markdown: 'authoritative final' },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private draft');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('authoritative final');
  });
  it('measures current semantic bytes after retract and preserves partial output when exceeded', async () => {
    const limits = { maxOutputBytes: 6, maxRetainedBytes: 8192 };
    expect(
      (
        await run(
          [progress('漢漢'), { type: 'retract' }, progress('answer'), complete('answer')],
          limits
        )
      ).events.at(-1)?.type
    ).toBe('briefing_complete');
    const { events, warn } = await run([progress('漢'), progress('漢漢')], limits);
    expect(events).toEqual([
      { type: 'briefing_delta', delta: '漢' },
      { type: 'briefing_error', code: 'response_safety_limit', retryable: false },
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ answerBytes: 9, maxOutputBytes: 6 }),
      'Assistant output safety limit exceeded'
    );
  });
  it('counts retained discarded text and empty replacements, not just current answer', async () => {
    const { events } = await run(
      [
        progress('first'),
        { type: 'retract' },
        progress('second'),
        { type: 'retract' },
        complete('final'),
      ],
      { maxOutputBytes: 1024, maxRetainedBytes: 140 }
    );
    expect(events.at(-1)).toEqual({
      type: 'briefing_error',
      code: 'response_safety_limit',
      retryable: false,
    });
    expect(events).toContainEqual({ type: 'briefing_delta', delta: 'second' });
    expect(events.some((event) => event.type === 'briefing_complete')).toBe(false);
  });
  it('replays every retained normalized event in order to a late subscriber', async () => {
    const source: BriefingEvent[] = [
      { type: 'briefing_delta', delta: 'discarded' },
      { type: 'briefing_replace', markdown: '' },
      { type: 'briefing_delta', delta: 'final' },
      { type: 'briefing_complete', markdown: 'final' },
    ];
    const producer = new RetainedAssistantGeneration();
    source.forEach((event) => producer.publish(event));
    expect(await Array.fromAsync(producer.subscribe())).toEqual(source);
  });
});

it('preserves a visible prefix when an authoritative replacement exceeds the semantic ceiling', async () => {
  const { events } = await run([progress('ok'), complete('oversized')], {
    maxOutputBytes: 4,
    maxRetainedBytes: 8192,
  });
  expect(events).toEqual([
    { type: 'briefing_delta', delta: 'ok' },
    { type: 'briefing_error', code: 'response_safety_limit', retryable: false },
  ]);
});
