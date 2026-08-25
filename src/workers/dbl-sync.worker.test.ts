import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bibleSyncModule from '@/domains/bibles/sync/dbl-bible-sync';
import * as bookSyncModule from '@/domains/books/sync/dbl-book-sync';
import * as languageSyncModule from '@/domains/languages/sync/dbl-language-sync';
import { ok } from '@/lib/types';

import { registerDblSyncWorker } from './dbl-sync.worker';

vi.mock('@/domains/languages/sync/dbl-language-sync', () => ({
  syncLanguagesFromDbl: vi.fn(),
}));

vi.mock('@/domains/bibles/sync/dbl-bible-sync', () => ({
  syncBiblesFromDbl: vi.fn(),
}));

vi.mock('@/domains/books/sync/dbl-book-sync', () => ({
  syncBooksFromDbl: vi.fn(),
}));

describe('dblSyncWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the on-demand worker and handles execution lifecycle', async () => {
    const mockBoss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    } as any;

    await registerDblSyncWorker(mockBoss);

    expect(mockBoss.work).toHaveBeenCalledWith('dbl-sync', expect.any(Function));

    const handler = mockBoss.work.mock.calls[0][1];

    vi.mocked(languageSyncModule.syncLanguagesFromDbl).mockResolvedValueOnce(ok({} as any));
    vi.mocked(bibleSyncModule.syncBiblesFromDbl).mockResolvedValueOnce(ok({} as any));
    vi.mocked(bookSyncModule.syncBooksFromDbl).mockResolvedValueOnce(ok({} as any));

    await handler({ id: 'job-1' });
    expect(languageSyncModule.syncLanguagesFromDbl).toHaveBeenCalledTimes(1);
    expect(bibleSyncModule.syncBiblesFromDbl).toHaveBeenCalledTimes(1);
    expect(bookSyncModule.syncBooksFromDbl).toHaveBeenCalledTimes(1);

    vi.mocked(languageSyncModule.syncLanguagesFromDbl).mockResolvedValueOnce({
      ok: false,
      error: { message: 'Sync failed' } as any,
    });
    await expect(handler({ id: 'job-2' })).rejects.toThrow('Sync failed');
  });
});
