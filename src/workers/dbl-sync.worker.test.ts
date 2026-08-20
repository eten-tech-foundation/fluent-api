import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerDblSyncWorker } from './dbl-sync.worker';
import * as ingestModule from './ingest-bibles';

vi.mock('./ingest-bibles', () => ({
  ingestDblBibles: vi.fn(),
}));

describe('dblSyncWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers the on-demand worker and handles execution lifecycle', async () => {
    const mockBoss = {
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    } as any;

    await registerDblSyncWorker(mockBoss);

    expect(mockBoss.work).toHaveBeenCalledWith('dbl-sync', expect.any(Function));

    const handler = mockBoss.work.mock.calls[0][1];

    vi.mocked(ingestModule.ingestDblBibles).mockResolvedValueOnce(undefined);
    await handler({ id: 'job-1' });
    expect(ingestModule.ingestDblBibles).toHaveBeenCalledTimes(1);

    vi.mocked(ingestModule.ingestDblBibles).mockRejectedValueOnce(new Error('Sync failed'));
    await expect(handler({ id: 'job-2' })).rejects.toThrow('Sync failed');
  });
});
