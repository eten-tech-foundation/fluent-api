import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { rateLimit } from './rate-limit';

function createContext(headers: Record<string, string> = {}) {
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
  } as any;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
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
});
