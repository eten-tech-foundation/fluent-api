import type { Server } from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeHttpServer, stopHttpAdmissionAndDrain } from '@/lib/http-shutdown';

describe('http shutdown', () => {
  afterEach(() => vi.useRealTimers());

  it('normally waits until the listener reports active responses drained', async () => {
    let drained!: (error?: Error) => void;
    const listener = {
      close: vi.fn((callback: (error?: Error) => void) => {
        drained = callback;
        return listener;
      }),
    } as unknown as Server;
    let settled = false;
    const closing = closeHttpServer(listener, 100).then((outcome) => {
      settled = true;
      return outcome;
    });

    await Promise.resolve();
    expect(listener.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    drained();
    await expect(closing).resolves.toBe('drained');
  });

  it('stops listener admission before settling active Assistant responses', async () => {
    const order: string[] = [];
    let drained!: () => void;
    const listener = {
      close: vi.fn((callback: () => void) => {
        order.push('listener-close');
        drained = callback;
        return listener;
      }),
    } as unknown as Server;

    const outcome = await stopHttpAdmissionAndDrain(listener, async () => {
      order.push('producer-shutdown');
      drained();
    });
    expect(outcome).toBe('drained');
    expect(order).toEqual(['listener-close', 'producer-shutdown']);
  });

  it('force-closes connections and finishes when normal drain exceeds its bound', async () => {
    vi.useFakeTimers();
    const listener = {
      close: vi.fn(() => listener),
      closeAllConnections: vi.fn(),
    } as unknown as Server;
    const closing = closeHttpServer(listener, 50);

    await vi.advanceTimersByTimeAsync(49);
    expect(listener.closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(closing).resolves.toBe('forced');
    expect(listener.closeAllConnections).toHaveBeenCalledOnce();
  });
});
