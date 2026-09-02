import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../db';
import { registerDblIngestTextWorker } from './ingest-bible-text.worker';

// Mock dependencies
vi.mock('../db', () => ({
  db: {
    query: {
      bibles: { findFirst: vi.fn() },
      books: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue(true),
        onConflictDoNothing: vi.fn().mockResolvedValue(true),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const queryChain: any = {
          where: vi.fn().mockResolvedValue([]),
          leftJoin: vi.fn(() => queryChain),
          innerJoin: vi.fn(() => queryChain),
          groupBy: vi.fn(() => queryChain),
          as: vi.fn(() => queryChain),
        };
        return queryChain;
      }),
    })),
  },
}));

const mockDblClientInstance = vi.hoisted(() => ({
  getChapters: vi.fn(),
  getChapter: vi.fn(),
}));

vi.mock('../lib/services/dbl/dbl.client', () => {
  return {
    dblClient: mockDblClientInstance,
  };
});

vi.mock('../domains/projects/usfm-import.service', () => ({
  materializePendingUsfmImports: vi
    .fn()
    .mockResolvedValue({ ok: true, data: { materialized: 0, pending: 0 } }),
}));

vi.mock('../domains/chapter-assignments/chapter-assignments.service', () => ({
  createChapterAssignmentForProjectUnit: vi.fn(),
}));

describe('dblIngestTextWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers handlers for both priority and background queues', async () => {
    const mockBoss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue(undefined),
    } as any;

    await registerDblIngestTextWorker(mockBoss);

    expect(mockBoss.work).toHaveBeenCalledTimes(2);
    expect(mockBoss.work).toHaveBeenCalledWith(
      'dbl-ingest-text',
      { batchSize: 1 },
      expect.any(Function)
    );
    expect(mockBoss.work).toHaveBeenCalledWith(
      'dbl-ingest-text-priority',
      { batchSize: 1 },
      expect.any(Function)
    );
  });

  it('handles partial download error recovery gracefully', async () => {
    const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
    await registerDblIngestTextWorker(mockBoss);

    // Extract the handler. pg-boss's WorkHandler always receives the batch as
    // an array, even at batchSize: 1 — see the array-wrapped call below.
    const handler = mockBoss.work.mock.calls[0][2];

    vi.mocked(db.query.bibles.findFirst).mockResolvedValue({
      id: 1,
      externalId: 'ext-bible-1',
    } as any);
    vi.mocked(db.query.books.findFirst).mockResolvedValue({ id: 1, code: 'GEN' } as any);

    mockDblClientInstance.getChapters.mockResolvedValue({
      ok: true,
      data: [{ id: 'GEN.1', number: '1' } as any, { id: 'GEN.2', number: '2' } as any],
    });

    // Simulate error on chapter 1, but chapter 2 succeeds with text content
    mockDblClientInstance.getChapter
      .mockResolvedValueOnce({ ok: false, error: { message: 'Network error on chapter 1' } })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          content: '   [1] Thus the heavens and the earth were completed.',
        },
      });

    await expect(
      handler([{ data: { bibleId: 1, bookCodes: ['GEN'] }, id: 'job-1' }])
    ).rejects.toThrow(/trigger retry/);

    // It should have continued to chapter 2 despite the error in chapter 1
    expect(mockDblClientInstance.getChapter).toHaveBeenCalledTimes(2);
    expect(db.insert).toHaveBeenCalledTimes(1); // Only for chapter 2
  });

  it('logs a warning and skips the book instead of silently ignoring it when no matching book exists', async () => {
    const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
    await registerDblIngestTextWorker(mockBoss);
    const handler = mockBoss.work.mock.calls[0][2];
    const { logger } = await import('../lib/logger');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    vi.mocked(db.query.bibles.findFirst).mockResolvedValue({
      id: 1,
      externalId: 'ext-bible-1',
    } as any);
    // No book in the DB matches this code.
    vi.mocked(db.query.books.findFirst).mockResolvedValue(undefined);

    await handler([{ data: { bibleId: 1, bookCodes: ['XYZ'] }, id: 'job-2' }]);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('XYZ'),
      expect.objectContaining({ bibleId: 1 })
    );
    // Never even attempts to fetch chapters for a book it couldn't resolve.
    expect(mockDblClientInstance.getChapters).not.toHaveBeenCalled();
  });

  it('marks a failed chapter-list fetch as a job failure so pg-boss retries, instead of silently dropping the whole book', async () => {
    const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
    await registerDblIngestTextWorker(mockBoss);
    const handler = mockBoss.work.mock.calls[0][2];

    vi.mocked(db.query.bibles.findFirst).mockResolvedValue({
      id: 1,
      externalId: 'ext-bible-1',
    } as any);
    vi.mocked(db.query.books.findFirst).mockResolvedValue({ id: 1, code: 'GEN' } as any);
    mockDblClientInstance.getChapters.mockResolvedValue({
      ok: false,
      error: { message: 'DBL returned 503' },
    });

    await expect(
      handler([{ data: { bibleId: 1, bookCodes: ['GEN'] }, id: 'job-3' }])
    ).rejects.toThrow(/trigger retry/);

    // A book whose chapter list couldn't be fetched has no chapters to fetch
    // content for.
    expect(mockDblClientInstance.getChapter).not.toHaveBeenCalled();
  });

  describe('chapter assignments after ingestion', () => {
    const setupProjectUnitsAndBooks = (projectUnitIds: number[], bookIds: number[]) => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(projectUnitIds.map((id) => ({ id }))),
        }),
      } as any);
      vi.mocked(db.query.books.findMany).mockResolvedValueOnce(
        bookIds.map((id) => ({ id })) as any
      );
    };

    beforeEach(() => {
      vi.mocked(db.query.bibles.findFirst).mockResolvedValue({
        id: 1,
        externalId: 'ext-bible-1',
      } as any);
      vi.mocked(db.query.books.findFirst).mockResolvedValue({ id: 7, code: 'GEN' } as any);
      mockDblClientInstance.getChapters.mockResolvedValue({ ok: true, data: [] });
    });

    it('logs success only when the assignment Result is ok', async () => {
      const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
      await registerDblIngestTextWorker(mockBoss);
      const handler = mockBoss.work.mock.calls[0][2];
      const { logger } = await import('../lib/logger');
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as any);

      const chapterAssignmentsService = await import(
        '../domains/chapter-assignments/chapter-assignments.service'
      );
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue({
        ok: true,
        data: [],
      } as any);
      setupProjectUnitsAndBooks([42], [7]);

      await handler([{ data: { bibleId: 1, bookCodes: ['GEN'], projectId: 99 }, id: 'job-4' }]);

      expect(infoSpy).toHaveBeenCalledWith(
        'Created chapter assignments for project unit after text ingestion',
        expect.objectContaining({ projectUnitId: 42 })
      );
    });

    it('finishes any imported USFM waiting on this text, once the assignments exist (#419)', async () => {
      const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
      await registerDblIngestTextWorker(mockBoss);
      const handler = mockBoss.work.mock.calls[0][2];

      const chapterAssignmentsService = await import(
        '../domains/chapter-assignments/chapter-assignments.service'
      );
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue({
        ok: true,
        data: [],
      } as any);
      const usfmImportService = await import('../domains/projects/usfm-import.service');
      setupProjectUnitsAndBooks([42], [7]);

      await handler([{ data: { bibleId: 1, bookCodes: ['GEN'], projectId: 99 }, id: 'job-6' }]);

      expect(usfmImportService.materializePendingUsfmImports).toHaveBeenCalledWith(42, 1, [7]);
    });

    it('does not log success and throws to trigger a retry when the assignment Result is an error', async () => {
      const mockBoss = { createQueue: vi.fn(), work: vi.fn() } as any;
      await registerDblIngestTextWorker(mockBoss);
      const handler = mockBoss.work.mock.calls[0][2];
      const { logger } = await import('../lib/logger');
      const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as any);
      const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);

      const chapterAssignmentsService = await import(
        '../domains/chapter-assignments/chapter-assignments.service'
      );
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue({
        ok: false,
        error: { message: 'insert failed', code: 'INTERNAL_ERROR' },
      } as any);
      setupProjectUnitsAndBooks([42], [7]);

      await expect(
        handler([{ data: { bibleId: 1, bookCodes: ['GEN'], projectId: 99 }, id: 'job-5' }])
      ).rejects.toThrow(/Failed to create chapter assignments/);

      expect(infoSpy).not.toHaveBeenCalledWith(
        'Created chapter assignments for project unit after text ingestion',
        expect.anything()
      );
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to create chapter assignments for project unit',
        expect.objectContaining({ projectUnitId: 42 })
      );
    });
  });
});
