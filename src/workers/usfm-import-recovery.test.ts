import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getUsfmImportsReadyForMaterialization } from '@/domains/projects/usfm-import.service';
import { logger } from '@/lib/logger';

import { startUsfmImportRecovery, USFM_IMPORT_RECOVERY_INTERVAL_MS } from './usfm-import-recovery';

vi.mock('@/domains/projects/usfm-import.service', () => ({
  getUsfmImportsReadyForMaterialization: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));

describe('pending USFM import recovery', () => {
  const findReady = vi.mocked(getUsfmImportsReadyForMaterialization);
  let stop: (() => Promise<void>) | undefined;
  const executeSql = vi.fn().mockResolvedValue({ rows: [] });
  const getQueue = vi.fn().mockResolvedValue({ deadLetter: 'usfm-import-materialize-dlq' });
  const schemaVersion = vi.fn().mockResolvedValue(26);
  const queue = (send: ReturnType<typeof vi.fn>) => ({
    send,
    getQueue,
    schemaVersion,
    getDb: () => ({ executeSql }),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    executeSql.mockResolvedValue({ rows: [] });
    getQueue.mockResolvedValue({ deadLetter: 'usfm-import-materialize-dlq' });
    schemaVersion.mockResolvedValue(26);
    findReady.mockResolvedValue([{ bibleId: 3, bookId: 1 }]);
  });

  afterEach(async () => {
    await stop?.();
    stop = undefined;
    vi.useRealTimers();
  });

  it('discovers imports created after startup and recovers a failed enqueue without restarting', async () => {
    findReady.mockResolvedValueOnce([]);
    const failure = new Error('queue unavailable');
    const send = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('retry-job');
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();

    // The import was committed after the initial sweep and its immediate retry was lost.
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Failed to recover pending USFM import', {
      bibleId: 3,
      bookId: 1,
      error: failure,
    });
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(
      'usfm-import-materialize',
      { bibleId: 3, bookId: 1 },
      { singletonKey: '3:1' }
    );

    findReady.mockResolvedValue([]); // The existing materializer completed it.
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries database discovery after a transient failure in the same worker', async () => {
    const failure = new Error('database unavailable');
    findReady.mockRejectedValueOnce(failure);
    const send = vi.fn().mockResolvedValue('retry-job');
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith('Failed to discover pending USFM imports', {
      error: failure,
    });
    expect(send).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
  });

  it('isolates a failed book and accepts singleton deduplication for another pending book', async () => {
    findReady.mockResolvedValue([
      { bibleId: 3, bookId: 1 },
      { bibleId: 3, bookId: 40 },
    ]);
    const send = vi.fn().mockRejectedValueOnce(new Error('enqueue failed')).mockResolvedValue(null);
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(send.mock.calls).toEqual([
      ['usfm-import-materialize', { bibleId: 3, bookId: 1 }, { singletonKey: '3:1' }],
      ['usfm-import-materialize', { bibleId: 3, bookId: 40 }, { singletonKey: '3:40' }],
    ]);
    expect(logger.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('leaves a dead-lettered book pending across sweeps and worker restarts while recovering other books', async () => {
    findReady.mockResolvedValue([
      { bibleId: 3, bookId: 1 },
      { bibleId: 3, bookId: 40 },
    ]);
    executeSql.mockResolvedValue({ rows: [{ key: '3:1' }] });
    const send = vi.fn().mockResolvedValue('new-job');
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS * 3);
    await stop();
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalled();
    expect(send.mock.calls.every((call) => call[1].bookId === 40)).toBe(true);

    // Clearing the retained failure after investigation permits recovery again.
    executeSql.mockResolvedValue({ rows: [] });
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledWith(
      'usfm-import-materialize',
      { bibleId: 3, bookId: 1 },
      { singletonKey: '3:1' }
    );
  });

  it('stops resubmitting when a previously queued job reaches the dead-letter queue', async () => {
    const send = vi.fn().mockResolvedValue('new-job');
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledOnce();
    executeSql.mockResolvedValue({ rows: [{ key: '3:1' }] });
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS * 5);
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not enqueue when retained failures cannot be inspected, then retries discovery', async () => {
    executeSql.mockRejectedValueOnce(new Error('database unavailable'));
    const send = vi.fn().mockResolvedValue('new-job');
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).toHaveBeenCalledOnce();
  });

  it('does not inspect or enqueue against an unsupported pg-boss schema', async () => {
    schemaVersion.mockResolvedValue(27);
    const send = vi.fn();
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(executeSql).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the configured dead-letter destination, including custom names', async () => {
    getQueue.mockResolvedValue({ deadLetter: 'custom-import-failures' });
    executeSql.mockResolvedValue({ rows: [{ key: '3:1' }] });
    const send = vi.fn();
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(executeSql).toHaveBeenCalledWith(expect.any(String), [
      'custom-import-failures',
      'usfm-import-materialize',
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not send if the materialization queue has no dead-letter destination', async () => {
    getQueue.mockResolvedValue({ deadLetter: null });
    const send = vi.fn();
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(0);
    expect(executeSql).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('does not overlap sweeps and stops sending before queue shutdown', async () => {
    let release!: () => void;
    const send = vi.fn().mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('retry-job');
        })
    );
    findReady.mockResolvedValue([
      { bibleId: 3, bookId: 1 },
      { bibleId: 3, bookId: 40 },
    ]);
    stop = startUsfmImportRecovery(queue(send));
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS * 2);
    expect(findReady).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();

    const stopped = stop();
    release();
    await stopped;
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(findReady).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it('bounds shutdown when discovery is stalled and skips late results', async () => {
    let release!: () => void;
    findReady.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([{ bibleId: 3, bookId: 1 }]);
        })
    );
    const send = vi.fn();
    stop = startUsfmImportRecovery(queue(send));
    const stopped = stop();
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;
    expect(logger.warn).toHaveBeenCalledWith('USFM import recovery shutdown timed out');
    release();
    await vi.advanceTimersByTimeAsync(USFM_IMPORT_RECOVERY_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });
});
