import type { PgBoss } from 'pg-boss';

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUSFMZipStreamAsync, getProjectName } from '@/domains/usfm/usfm.service';
import { uploadExportStream } from '@/lib/blob-storage';

import { registerUSFMExportWorker } from './usfm-export.worker';

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/lib/blob-storage', () => ({
  uploadExportStream: vi.fn(),
}));

vi.mock('@/domains/usfm/usfm.service', () => ({
  createUSFMZipStreamAsync: vi.fn(),
  getProjectName: vi.fn(),
}));

type WorkHandler = (jobs: { id: string; data: unknown }[]) => Promise<unknown>;

function createFakeBoss() {
  const work = vi.fn().mockResolvedValue(undefined);
  const boss = { work } as unknown as PgBoss;
  const getHandler = (): WorkHandler => work.mock.calls[0][2] as WorkHandler;
  const getOptions = (): Record<string, unknown> => work.mock.calls[0][1];
  return { boss, work, getHandler, getOptions };
}

const job = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  data: { projectUnitId: 1, bookIds: [1], requestedBy: 42 },
};

describe('registerUSFMExportWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers with batchSize 1 so per-job failures reach pg-boss', async () => {
    const { boss, getOptions } = createFakeBoss();
    await registerUSFMExportWorker(boss);

    expect(getOptions()).toMatchObject({ batchSize: 1 });
  });

  it('rejects (so pg-boss retries) when export processing fails', async () => {
    const { boss, getHandler } = createFakeBoss();
    const hooks = { onJobFailure: vi.fn(), onJobSuccess: vi.fn(), onBatchEnd: vi.fn() };
    await registerUSFMExportWorker(boss, hooks);

    vi.mocked(createUSFMZipStreamAsync).mockResolvedValue({ ok: false } as any);

    await expect(getHandler()([job])).rejects.toThrow('No books available for export');
    expect(hooks.onJobFailure).toHaveBeenCalledTimes(1);
    expect(hooks.onJobSuccess).not.toHaveBeenCalled();
    expect(hooks.onBatchEnd).toHaveBeenCalledTimes(1);
  });

  it('rejects when the blob upload fails, and still runs cleanup', async () => {
    const { boss, getHandler } = createFakeBoss();
    await registerUSFMExportWorker(boss);

    const cleanup = vi.fn();
    vi.mocked(createUSFMZipStreamAsync).mockResolvedValue({
      ok: true,
      data: { stream: Readable.from(['zip-bytes']), cleanup },
    } as any);
    vi.mocked(uploadExportStream).mockRejectedValue(new Error('blob unavailable'));

    await expect(getHandler()([job])).rejects.toThrow('blob unavailable');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('resolves with the download result on success', async () => {
    const { boss, getHandler } = createFakeBoss();
    const hooks = { onJobFailure: vi.fn(), onJobSuccess: vi.fn() };
    await registerUSFMExportWorker(boss, hooks);

    const cleanup = vi.fn();
    vi.mocked(createUSFMZipStreamAsync).mockResolvedValue({
      ok: true,
      data: { stream: Readable.from(['zip-bytes']), cleanup },
    } as any);
    vi.mocked(uploadExportStream).mockResolvedValue({
      filename: `export-${job.id}.zip`,
      sizeBytes: 9,
      expiresAt: new Date('2026-01-01T01:00:00Z'),
    });
    vi.mocked(getProjectName).mockResolvedValue({ ok: true, data: 'My Project' } as any);

    const result = (await getHandler()([job])) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      projectUnitId: 1,
      downloadUrl: `/downloads/export-${job.id}.zip`,
      displayFilename: 'My Project.zip',
    });
    expect(uploadExportStream).toHaveBeenCalledWith(job.id, expect.anything(), {
      requestedby: '42',
      projectunitid: '1',
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(hooks.onJobSuccess).toHaveBeenCalledTimes(1);
    expect(hooks.onJobFailure).not.toHaveBeenCalled();
  });
});
