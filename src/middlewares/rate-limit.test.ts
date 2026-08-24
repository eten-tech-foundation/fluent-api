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

// Live object so tests can vary the knobs (#210); beforeEach restores defaults.
const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    RATE_LIMIT_MAX_BUCKETS: 10_000,
    RATE_LIMIT_TRUSTED_HOPS: 1,
  },
}));

vi.mock('@/env', () => ({ default: mockEnv }));

function createContext(headers: Record<string, string> = {}, remoteAddress?: string) {
  const setHeaders: Record<string, string> = {};
  return {
    req: {
      header: vi.fn((name: string) => headers[name.toLowerCase()]),
    },
    header: vi.fn((name: string, value: string) => {
      setHeaders[name] = value;
    }),
    json: vi.fn((data: unknown, status?: number) => ({ data, status })),
    setHeaders,
    // @hono/node-server exposes the raw request as c.env.incoming.
    env: remoteAddress ? { incoming: { socket: { remoteAddress } } } : {},
  } as any;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    mockEnv.RATE_LIMIT_MAX_BUCKETS = 10_000;
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 1;
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

  it('with two trusted hops, keys on the second-from-last forwarded entry', async () => {
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 2;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    // Client → LB1 → LB2: LB1 appends the real client (5.5.5.5), LB2 appends
    // LB1's address. Leading entries and the final hop differ, but the keyed
    // entry is the same client.
    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1, 5.5.5.5, 9.9.9.9' }), next);
    const blocked = createContext({ 'x-forwarded-for': '2.2.2.2, 5.5.5.5, 8.8.8.8' });
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('with two trusted hops, tracks distinct clients in separate buckets', async () => {
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 2;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '5.5.5.5, 9.9.9.9' }), next);
    await middleware(createContext({ 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('shares one bucket when fewer forwarded entries than trusted hops', async () => {
    // A request that did not pass through all trusted proxies has no
    // trustworthy client entry — same fallback as a missing header.
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 2;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }), next);
    const blocked = createContext({ 'x-forwarded-for': '2.2.2.2' });
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('with zero trusted hops, keys on the socket address and ignores x-forwarded-for', async () => {
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 0;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    // Different (spoofable) headers, same socket → same bucket.
    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }, '10.0.0.1'), next);
    const blocked = createContext({ 'x-forwarded-for': '2.2.2.2' }, '10.0.0.1');
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('with zero trusted hops, tracks distinct sockets in separate buckets', async () => {
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 0;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({}, '10.0.0.1'), next);
    await middleware(createContext({}, '10.0.0.2'), next);

    expect(next).toHaveBeenCalledTimes(2);
  });

  it('with zero trusted hops and no socket info, shares one bucket', async () => {
    mockEnv.RATE_LIMIT_TRUSTED_HOPS = 0;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext(), next);
    const blocked = createContext();
    await middleware(blocked, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(blocked.json).toHaveBeenCalledWith({ message: 'Too many requests' }, 429);
  });

  it('applies the bucket cap from env, evicting the oldest client', async () => {
    mockEnv.RATE_LIMIT_MAX_BUCKETS = 2;
    const middleware = rateLimit({ windowMs: 60_000, max: 1 });
    const next = vi.fn();

    await middleware(createContext({ 'x-forwarded-for': '1.1.1.1' }), next);
    await middleware(createContext({ 'x-forwarded-for': '2.2.2.2' }), next);
    // Third client exceeds the cap → oldest (1.1.1.1) is evicted.
    await middleware(createContext({ 'x-forwarded-for': '3.3.3.3' }), next);

    // With its bucket evicted, 1.1.1.1 gets a fresh window instead of a 429.
    const refreshed = createContext({ 'x-forwarded-for': '1.1.1.1' });
    await middleware(refreshed, next);

    expect(refreshed.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(4);
  });
});
