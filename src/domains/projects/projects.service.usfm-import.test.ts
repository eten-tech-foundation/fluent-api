import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { createChapterAssignmentForProjectUnit } from '@/domains/chapter-assignments/chapter-assignments.service';
import { getQueue } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './projects.repository';
import { createProject } from './projects.service';
import * as usfmImportService from './usfm-import.service';

const mockTx = { _isMockTx: true };

vi.mock('@/db', () => {
  const chain = (rows: unknown[]) =>
    vi.fn(() => ({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      then: (resolve: (rows: unknown[]) => void) => resolve(rows),
    }));
  return {
    db: {
      transaction: vi.fn(),
      selectDistinct: chain([]),
      select: chain([]),
      query: { books: { findMany: vi.fn().mockResolvedValue([]) } },
    },
  };
});

vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: {
    DBL_INGEST_TEXT: 'dbl-ingest-text',
    DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
  },
}));

vi.mock('./projects.repository', () => ({
  getValidBookIdsForBible: vi.fn(),
  insertProjectRecord: vi.fn(),
  insertProjectUnitRecord: vi.fn(),
  insertBibleBookLinks: vi.fn(),
  insertUsfmImports: vi.fn(),
}));

vi.mock('./usfm-import.service', () => ({
  parseUsfmFiles: vi.fn(),
  materializePendingUsfmImports: vi.fn(),
}));

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  createChapterAssignmentForProjectUnit: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const FILES = [
  { fileName: 'gen.usfm', bookCode: 'GEN', usfm: '\\id GEN\n\\c 1\n\\v 1 x' },
  { fileName: 'mat.usfm', bookCode: 'MAT', usfm: '\\id MAT\n\\c 1\n\\v 1 y' },
];

const PARSED = FILES.map((file, index) => ({
  ...file,
  bookId: index === 0 ? 1 : 40,
  verses: [{ chapterNumber: 1, verseNumber: 1, text: 'x' }],
}));

const BASE = {
  name: 'Imported',
  isActive: true,
  sourceLanguage: 1,
  targetLanguage: 2,
  bibleId: 3,
  // The client's book list is deliberately wrong here: the files decide.
  bookId: [99],
  projectUnitStatus: 'not_started' as const,
  connectivityProfile: null,
  pericopeSetId: null,
  organization: 7,
  createdBy: 11,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx as never));
  vi.mocked(repo.getValidBookIdsForBible).mockResolvedValue([1, 40, 99]);
  vi.mocked(repo.insertProjectRecord).mockResolvedValue({ id: 500 } as never);
  vi.mocked(repo.insertProjectUnitRecord).mockResolvedValue({ id: 600 } as never);
  vi.mocked(createChapterAssignmentForProjectUnit).mockResolvedValue(ok([]));
  vi.mocked(getQueue).mockResolvedValue({ send: vi.fn() } as never);
  vi.mocked(usfmImportService.parseUsfmFiles).mockResolvedValue(ok(PARSED));
  vi.mocked(usfmImportService.materializePendingUsfmImports).mockResolvedValue(
    ok({ materialized: 2, pending: 0 })
  );
});

describe('createProject from USFM files (#419)', () => {
  it('creates the project for the books the files carry, not the ones the client listed', async () => {
    const result = await createProject({ ...BASE, usfmFiles: FILES });

    expect(result.ok).toBe(true);
    expect(repo.insertBibleBookLinks).toHaveBeenCalledWith(
      [
        { projectUnitId: 600, bibleId: 3, bookId: 1 },
        { projectUnitId: 600, bibleId: 3, bookId: 40 },
      ],
      mockTx
    );
    expect(createChapterAssignmentForProjectUnit).toHaveBeenCalledWith(600, 3, [1, 40], mockTx);
  });

  it('stores every file verbatim inside the creating transaction', async () => {
    await createProject({ ...BASE, usfmFiles: FILES });

    expect(repo.insertUsfmImports).toHaveBeenCalledWith(
      [
        { projectUnitId: 600, bookId: 1, fileName: 'gen.usfm', usfm: FILES[0].usfm },
        { projectUnitId: 600, bookId: 40, fileName: 'mat.usfm', usfm: FILES[1].usfm },
      ],
      mockTx
    );
  });

  it('materialises the verses after the transaction, for the imported books only', async () => {
    await createProject({ ...BASE, usfmFiles: FILES });

    expect(usfmImportService.materializePendingUsfmImports).toHaveBeenCalledWith(600, 3, [1, 40]);
  });

  it('writes nothing when a file fails to parse', async () => {
    vi.mocked(usfmImportService.parseUsfmFiles).mockResolvedValue(err(ErrorCode.USFM_INVALID));

    const result = await createProject({ ...BASE, usfmFiles: FILES });

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('leaves the blank-project flow exactly alone when no files are sent', async () => {
    await createProject({ ...BASE, bookId: [1] });

    expect(usfmImportService.parseUsfmFiles).not.toHaveBeenCalled();
    expect(repo.insertUsfmImports).not.toHaveBeenCalled();
    expect(usfmImportService.materializePendingUsfmImports).not.toHaveBeenCalled();
    expect(repo.insertBibleBookLinks).toHaveBeenCalledWith(
      [{ projectUnitId: 600, bibleId: 3, bookId: 1 }],
      mockTx
    );
  });
});
