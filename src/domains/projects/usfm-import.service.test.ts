import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bible_texts, books } from '@/db/schema';
import { ErrorCode } from '@/lib/types';

import * as repo from './projects.repository';
import {
  materializePendingUsfmImports,
  materializeUsfmImport,
  parseUsfmFiles,
} from './usfm-import.service';

// The parser is real; only the database and the repository are stood in for.

/** Rows the mocked `db.select().from(table).where()` returns, keyed by table. */
const rowsByTable = new Map<unknown, unknown[]>();
const inserted: unknown[][] = [];

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(() => ({
      from: (table: unknown) => ({
        where: () => Promise.resolve(rowsByTable.get(table) ?? []),
      }),
    })),
    insert: vi.fn(() => ({
      values: (rows: unknown[]) => {
        inserted.push(rows);
        return { onConflictDoNothing: () => Promise.resolve() };
      },
    })),
  },
}));

vi.mock('./projects.repository', () => ({
  getPendingUsfmImports: vi.fn(),
  markUsfmImportMaterialized: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const GEN = '\\id GEN Genesis\n\\c 1\n\\p\n\\v 1 In the beginning.\n\\v 2 The earth.';
const MAT = '\\id MAT Matthew\n\\c 1\n\\p\n\\v 1 The genealogy.';

beforeEach(() => {
  vi.clearAllMocks();
  rowsByTable.clear();
  inserted.length = 0;
  rowsByTable.set(books, [
    { id: 1, code: 'GEN' },
    { id: 40, code: 'MAT' },
  ]);
});

describe('parseUsfmFiles (#419)', () => {
  it('resolves each file to its book and its verses', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'gen', usfm: GEN },
      { fileName: 'mat.usfm', bookCode: 'MAT', usfm: MAT },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.map((f) => [f.bookCode, f.bookId, f.verses.length])).toEqual([
      ['GEN', 1, 2],
      ['MAT', 40, 1],
    ]);
  });

  it('rejects the whole batch when one file is not USFM', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: GEN },
      { fileName: 'notes.usfm', bookCode: 'MAT', usfm: 'just a note, no markers' },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
  });

  it('rejects a book the catalogue does not know', async () => {
    const result = await parseUsfmFiles([{ fileName: 'x.usfm', bookCode: 'ZZZ', usfm: GEN }]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISMATCH } });
  });

  it('rejects a file whose \\id disagrees with the book it was uploaded as', async () => {
    // Claims Matthew, but the file says it is Genesis.
    const result = await parseUsfmFiles([{ fileName: 'mat.usfm', bookCode: 'MAT', usfm: GEN }]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISMATCH } });
  });

  it('rejects two files for the same book', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'a.usfm', bookCode: 'GEN', usfm: GEN },
      { fileName: 'b.usfm', bookCode: 'gen', usfm: GEN },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISMATCH } });
  });
});

describe('materializeUsfmImport (#419)', () => {
  const row = { id: 9, projectUnitId: 5, bookId: 1, usfm: GEN };

  it('reports pending and writes nothing while the source text is not ingested', async () => {
    rowsByTable.set(bible_texts, []);

    const result = await materializeUsfmImport(row, 3);

    expect(result).toEqual({ ok: true, data: 'pending' });
    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('attaches each verse to its source row once the text exists', async () => {
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);

    const result = await materializeUsfmImport(row, 3);

    expect(result).toEqual({ ok: true, data: 'materialized' });
    expect(inserted).toEqual([
      [
        { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
        { projectUnitId: 5, bibleTextId: 102, content: 'The earth.' },
      ],
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledWith(9, db);
  });

  it('skips verses the source does not have instead of inventing rows', async () => {
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    await materializeUsfmImport(row, 3);

    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
    ]);
  });
});

describe('materializePendingUsfmImports (#419)', () => {
  it('finishes whatever is pending and counts what still waits', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: GEN },
      { id: 2, projectUnitId: 5, bookId: 40, usfm: MAT },
    ]);
    // Genesis is ingested for this bible, Matthew is not: the mock answers by table, so make
    // the source rows match Genesis only by chapter and verse.
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    const result = await materializePendingUsfmImports(5, 3, [1, 40]);

    expect(result.ok).toBe(true);
    expect(repo.getPendingUsfmImports).toHaveBeenCalledWith(5, [1, 40]);
  });

  it('asks for nothing when there are no books', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([]);

    const result = await materializePendingUsfmImports(5, 3, []);

    expect(result).toEqual({ ok: true, data: { materialized: 0, pending: 0 } });
  });
});
