import { expect, it, vi } from 'vitest';

import { BtServantClient } from './assistant.client';

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
