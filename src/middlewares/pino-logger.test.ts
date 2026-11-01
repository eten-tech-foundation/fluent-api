import { beforeEach, describe, expect, it, vi } from 'vitest';

import createApp from '@/lib/create-app';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock('@/env', () => ({ default: { NODE_ENV: 'test', LOG_LEVEL: 'info' } }));
// Capture real Pino output before pretty-printing; do not mock its serializers.
vi.mock('pino-pretty', () => ({
  default: () => ({ write: (line: string) => logs.push(line) }),
}));

describe('http logging privacy', () => {
  beforeEach(() => {
    logs.length = 0;
  });

  it.each([200, 401, 500] as const)(
    'logs safe metadata without credentials or payloads for status %i',
    async (status) => {
      const app = createApp();
      app.onError((_error, c) => c.json({ error: 'provider-response-secret' }, 500));
      app.post('/assistant/conversation', async (c) => {
        const body = await c.req.json();
        expect(body).toEqual({ question: 'private-question', receipt: 'private-receipt' });
        c.header('Set-Cookie', 'session=response-cookie-secret; HttpOnly');
        c.header('X-Receipt', 'response-receipt-secret');
        if (status === 500) throw new Error('provider-error-secret');
        return c.json({ answer: 'provider-response-secret' }, status);
      });

      const response = await app.request('/assistant/conversation?token=query-secret', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: 'session=request-cookie-secret',
          Authorization: 'Bearer authorization-secret',
          'X-Api-Key': 'api-key-secret',
          'X-Receipt': 'request-receipt-secret',
          'X-Request-Id': 'request-id-secret',
        },
        body: JSON.stringify({ question: 'private-question', receipt: 'private-receipt' }),
      });

      expect(response.status).toBe(status);
      expect(logs).toHaveLength(1);
      const entry = JSON.parse(logs[0]);
      expect(entry.req).toEqual({ method: 'POST', url: '/assistant/conversation' });
      expect(entry.res).toEqual({ status });
      expect(entry.reqId).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.headers.get('X-Request-Id')).toBe(entry.reqId);
      expect(entry.responseTime).toEqual(expect.any(Number));
      expect(entry.level).toBe(status === 500 ? 50 : 30);
      expect(entry.msg).toBe(status === 500 ? 'Request failed' : 'Request completed');
      expect(logs.join('')).not.toMatch(/secret|private-question|private-receipt/);
      expect(entry).not.toHaveProperty('err');
    }
  );
});
