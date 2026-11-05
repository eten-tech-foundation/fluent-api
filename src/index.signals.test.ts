import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serve: vi.fn(() => ({})),
  drain: vi.fn<() => Promise<string>>(),
  stopQueue: vi.fn(async () => {}),
  stopMonitor: vi.fn(async () => {}),
}));
vi.mock('@hono/node-server', () => ({ serve: mocks.serve }));
vi.mock('./app', () => ({ default: { fetch: vi.fn() } }));
vi.mock('@/env', () => ({ default: { PORT: 3000 } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/domains/assistant/assistant.cache', () => ({ shutdownInFlightGenerations: vi.fn() }));
vi.mock('@/domains/verse-audio/verse-audio.service', () => ({
  reclaimOrphanedStorageObjects: vi.fn(),
}));
vi.mock('@/lib/audio-storage', () => ({
  initializeAudioStorage: vi.fn(),
  isAudioStorageConfigured: () => false,
}));
vi.mock('@/lib/blob-storage', () => ({ verifyBlobStorageOnBoot: async () => {} }));
vi.mock('@/lib/dead-letter-queues', () => ({ startDeadLetterMonitor: () => mocks.stopMonitor }));
vi.mock('@/lib/http-shutdown', () => ({ stopHttpAdmissionAndDrain: mocks.drain }));
vi.mock('@/lib/queue', () => ({
  initializeQueueWithRetry: async () => ({}),
  stopQueue: mocks.stopQueue,
}));

afterEach(() => vi.restoreAllMocks());

it('drains and exits only once when both shutdown signals arrive repeatedly', async () => {
  let finish!: (value: string) => void;
  mocks.drain.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  const signals = new Map<string, () => void>();
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    if (event === 'SIGTERM' || event === 'SIGINT') signals.set(event, listener);
    return process;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  await import('./index');
  await Promise.resolve();
  signals.get('SIGTERM')!();
  signals.get('SIGINT')!();
  signals.get('SIGTERM')!();
  expect(mocks.drain).toHaveBeenCalledOnce();
  expect(mocks.stopMonitor).toHaveBeenCalledOnce();
  expect(mocks.stopQueue).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  finish('drained');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0));
  expect(mocks.stopQueue).toHaveBeenCalledOnce();
  signals.get('SIGINT')!();
  expect(mocks.drain).toHaveBeenCalledOnce();
});
