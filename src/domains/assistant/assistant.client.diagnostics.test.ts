import { Buffer } from 'node:buffer';
import { expect, it, vi } from 'vitest';

import { boundedEventType, BtServantClient } from './assistant.client';

it('bounds event-type diagnostics by UTF-8 bytes without splitting a code point', () => {
  expect(boundedEventType('a'.repeat(64))).toBe('a'.repeat(64));
  expect(boundedEventType('a'.repeat(65))).toBe(`${'a'.repeat(61)}...`);
  const multibyte = boundedEventType(`${'界'.repeat(21)}xx`);
  expect(multibyte).toBe(`${'界'.repeat(20)}...`);
  expect(Buffer.byteLength(multibyte)).toBe(63);
});

it('logs unsupported frames with event metadata while accepting comments and empty frames', async () => {
  const warn = vi.fn();
  const client = new BtServantClient({
    baseUrl: 'https://bt.invalid',
    engineKey: 'fixture',
    org: 'fluent',
    connectMs: 100,
    idleMs: 100,
    totalMs: 100,
    maxOutputBytes: 100,
    maxFrameBytes: 1000,
    warn,
    fetch: async () =>
      new Response(
        [
          ': keepalive\n\n\n\ndata: {"type":"new_kind"}\n\ndata: {"type":"progress","text":42}\n\nevent: orphan\n\ndata: {"type":"complete","response":{"responses":["answer"]}}\n\n',
        ].join('')
      ),
  });
  const events = [];
  for await (const event of client.stream({
    userId: 'fluent_1',
    message: 'x',
    responseLanguageHint: 'en',
  }))
    events.push(event);
  expect(events.at(-1)?.type).toBe('briefing_complete');
  expect(warn.mock.calls).toEqual([
    [{ eventType: 'new_kind' }, 'Assistant upstream event unsupported'],
    [{ eventType: 'progress', textType: 'number' }, 'Assistant upstream progress skipped'],
    [{ reason: 'missing_data' }, 'Assistant upstream frame skipped'],
  ]);
});
