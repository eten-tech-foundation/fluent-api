import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';

import { rateLimit } from './rate-limit';

vi.mock('@/lib/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

function createContext(headers: Record<string, string> = {}, socketAddress?: string) {
  const setHeaders: Record<string, string> = {};
  return {
    env: socketAddress
      ? {
          incoming: {
            socket: { remoteAddress: socketAddress, remoteFamily: 'IPv4', remotePort: 40_000 },
          },
        }
      : undefined,
    req: {
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    header: vi.fn((name: string, value: string) => {
      setHeaders[name] = value;
    }),
    json: vi.fn((data: unknown, status?: number) => ({ data, status })),
    setHeaders,
  } as any;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 3 });
    const next = vi.fn();

    for (let i = 0; i < 3; i++) {
      const c = createContext({ 'x-forwarded-for': '1.2.3.4' });
      await middleware(c, next);
    }

    expect(next).toHaveBeenCalledTimes(3);
  });

  it('blocks requests over the limit with 429 and Retry-After', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 2 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.2.3.4' }), next);
    await middleware(createContext({ 'x-forwarded-for': '1.2.3.4' }), next);

    const blocked = createContext({ 'x-forwarded-for': '1.2.3.4' });
    const result = await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
    expect(blocked.setHeaders['Retry-After']).toBe('60');
    expect(result).toEqual({ data: { message: 'Too many requests' }, status: 429 });
    expect(logger.warn).toHaveBeenCalledWith(
      'Rate limit exceeded',
      expect.objectContaining({ client: '1.2.3.4', limit: 2 })
    );
  });

  it('resets the window after windowMs elapses', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.2.3.4' }), next);

    const blocked = createContext({ 'x-forwarded-for': '1.2.3.4' });
    await middleware(blocked, next);
    expect(blocked.json).toHaveBeenCalled();

    vi.advanceTimersByTime(60_001);

    const allowed = createContext({ 'x-forwarded-for': '1.2.3.4' });
    await middleware(allowed, next);
    expect(allowed.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('tracks clients independently by forwarded IP', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }), next);
    await middleware(createContext({ 'x-forwarded-for': '2.2.2.2' }), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('keys on the last (proxy-appended) hop so spoofed leading entries share a bucket', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1, 9.9.9.9' }), next);
    const blocked = createContext({ 'x-forwarded-for': '2.2.2.2, 9.9.9.9' });
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('tracks distinct last hops in separate buckets', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '9.9.9.9, 1.1.1.1' }), next);
    await middleware(createContext({ 'x-forwarded-for': '9.9.9.9, 2.2.2.2' }), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('strips the port from the last hop so the same IP shares a bucket', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '9.9.9.9:1111' }), next);
    const blocked = createContext({ 'x-forwarded-for': '9.9.9.9:2222' });
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('resolves limits from env defaults when options are omitted', async () => {
    const middleware = rateLimit();
    const next = vi.fn();

    for (let i = 0; i < 20; i++) {
      await middleware(createContext({ 'x-forwarded-for': '1.2.3.4' }), next);
    }
    expect(next).toHaveBeenCalledTimes(20);

    const blocked = createContext({ 'x-forwarded-for': '1.2.3.4' });
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(20);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
    expect(logger.warn).toHaveBeenCalledWith(
      'Rate limit exceeded',
      expect.objectContaining({ limit: 20, windowMs: 60_000 })
    );
  });

  it('honors a custom maxBuckets by evicting the oldest bucket at capacity', async () => {
    const middleware = rateLimit({ windowMs: 60_000, max: 1, maxBuckets: 2, trustedHops: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }), next);
    await middleware(createContext({ 'x-forwarded-for': '2.2.2.2' }), next);
    await middleware(createContext({ 'x-forwarded-for': '3.3.3.3' }), next);

    const again = createContext({ 'x-forwarded-for': '1.1.1.1' });
    await middleware(again, next);

    expect(next).toHaveBeenCalledTimes(4);
    expect(again.json).not.toHaveBeenCalled();
  });

  describe('trusted hops', () => {
    it('trustedHops=0 keys on the socket address and ignores x-forwarded-for', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 0 });
      const next = vi.fn();

      await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }, '9.9.9.9'), next);
      const blocked = createContext({ 'x-forwarded-for': '2.2.2.2' }, '9.9.9.9');
      await middleware(blocked, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
      expect(logger.warn).toHaveBeenCalledWith(
        'Rate limit exceeded',
        expect.objectContaining({ client: '9.9.9.9' })
      );
    });

    it('trustedHops=0 tracks distinct sockets separately', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 0 });
      const next = vi.fn();

      await middleware(createContext({}, '9.9.9.9'), next);
      await middleware(createContext({}, '8.8.8.8'), next);

      expect(next).toHaveBeenCalledTimes(2);
    });

    it('falls back to the socket address when x-forwarded-for is absent', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 1 });
      const next = vi.fn();

      await middleware(createContext({}, '9.9.9.9'), next);
      const blocked = createContext({}, '9.9.9.9');
      await middleware(blocked, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
    });

    it('trustedHops=2 keys on the second-from-last entry', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 2 });
      const next = vi.fn();

      await middleware(createContext({ 'x-forwarded-for': 'spoof, 1.1.1.1, 10.0.0.7' }), next);
      const blocked = createContext({ 'x-forwarded-for': 'other, 1.1.1.1, 10.0.0.7' });
      await middleware(blocked, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
    });

    it('trustedHops=2 separates clients that differ in the second-from-last entry', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 2 });
      const next = vi.fn();

      await middleware(createContext({ 'x-forwarded-for': '1.1.1.1, 10.0.0.7' }), next);
      await middleware(createContext({ 'x-forwarded-for': '2.2.2.2, 10.0.0.7' }), next);

      expect(next).toHaveBeenCalledTimes(2);
    });

    it('degrades to the leftmost entry when hops exceed the chain length', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 3 });
      const next = vi.fn();

      await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }, '10.0.0.7'), next);
      const blocked = createContext({ 'x-forwarded-for': '1.1.1.1' }, '10.0.0.8');
      await middleware(blocked, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
    });

    it('shares the unknown bucket when neither proxy header nor socket is available', async () => {
      const middleware = rateLimit({ windowMs: 60_000, max: 1, trustedHops: 1 });
      const next = vi.fn();

      await middleware(createContext(), next);
      const blocked = createContext();
      await middleware(blocked, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'Rate limit exceeded',
        expect.objectContaining({ client: 'unknown' })
      );
    });
  });
});
