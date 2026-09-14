import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { bible_books, bible_texts, books } from '@/db/schema';
import { logger } from '@/lib/logger';
import { ErrorCode } from '@/lib/types';
import * as converter from '@/lib/usfm-converter';

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
const GEN_WITH_HEADING =
  '\\id GEN\n\\c 1\n\\p\n\\v 1 First.\n\\s1 The Creation\n\\p\n\\v 2 Second.';
const MAT = '\\id MAT Matthew\n\\c 1\n\\p\n\\v 1 The genealogy.';

beforeEach(() => {
  vi.clearAllMocks();
  rowsByTable.clear();
  inserted.length = 0;
  rowsByTable.set(books, [
    { id: 1, code: 'GEN' },
    { id: 40, code: 'MAT' },
  ]);
  rowsByTable.set(bible_books, [{ textIngestedAt: new Date() }]);
});

afterEach(() => {
  vi.restoreAllMocks();
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

  it('keeps a section heading separate from verse text and anchors it to the following verse', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: GEN_WITH_HEADING },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].verses).toEqual([
      { chapterNumber: 1, verseNumber: 1, text: 'First.' },
      {
        chapterNumber: 1,
        verseNumber: 2,
        text: 'Second.',
        markers: { headings: [{ marker: 's1', text: 'The Creation' }] },
      },
    ]);
  });

  it('rejects the whole batch when one file is not USFM', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: GEN },
      { fileName: 'notes.usfm', bookCode: 'MAT', usfm: 'just a note, no markers' },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
  });

  it('rejects a trailing heading that no verse can retain', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: `${GEN}\n\\s1 Appendix` },
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
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: ErrorCode.USFM_BOOK_MISMATCH,
        message: 'USFM book code is invalid or does not match the uploaded file',
      },
    });
  });

  it('rejects a parsed file without a book identifier', async () => {
    vi.spyOn(converter, 'convertUSFMToUSJ').mockReturnValueOnce({
      ok: true,
      data: { type: 'USJ', version: '3.1', content: [] },
    });
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: '\\c 1\n\\p\n\\v 1 Text without a book.' },
    ]);
    expect(result).toMatchObject({
      ok: false,
      error: { code: ErrorCode.USFM_BOOK_MISSING, message: 'Missing book data' },
    });
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

  it('waits for confirmed book completion even when some source verses already exist', async () => {
    rowsByTable.set(bible_books, [{ textIngestedAt: null }]);
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'pending' });
    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();

    rowsByTable.set(bible_books, [{ textIngestedAt: new Date() }]);
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'materialized' });
    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
      { projectUnitId: 5, bibleTextId: 102, content: 'The earth.' },
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, db);
  });

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

  it('reparses a delayed import and stores heading markers separately from content', async () => {
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);

    const result = await materializeUsfmImport({ ...row, usfm: GEN_WITH_HEADING }, 3);

    expect(result).toEqual({ ok: true, data: 'materialized' });
    expect(inserted).toEqual([
      [
        { projectUnitId: 5, bibleTextId: 101, content: 'First.' },
        {
          projectUnitId: 5,
          bibleTextId: 102,
          content: 'Second.',
          markers: { headings: [{ marker: 's1', text: 'The Creation' }] },
        },
      ],
    ]);
  });

  it('stores an empty verse when it carries a heading', async () => {
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);
    const usfm = '\\id GEN\n\\c 1\n\\p\n\\v 1 First.\n\\s1 Empty Section\n\\p\n\\v 2';

    await materializeUsfmImport({ ...row, usfm }, 3);

    expect(inserted[0]).toContainEqual({
      projectUnitId: 5,
      bibleTextId: 102,
      content: '',
      markers: { headings: [{ marker: 's1', text: 'Empty Section' }] },
    });
  });

  it('materializes verses around a textless semantic division without treating it as a heading', async () => {
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);
    const usfm = '\\id GEN\n\\c 1\n\\p\n\\v 1 First.\n\\sd1\n\\p\n\\v 2 Second.';

    const result = await materializeUsfmImport({ ...row, usfm }, 3);

    expect(result).toEqual({ ok: true, data: 'materialized' });
    expect(inserted).toEqual([
      [
        { projectUnitId: 5, bibleTextId: 101, content: 'First.' },
        { projectUnitId: 5, bibleTextId: 102, content: 'Second.' },
      ],
    ]);
  });

  it('rejects invalid imported heading structure before inserting or marking the import', async () => {
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);

    const result = await materializeUsfmImport(row, 3, db, [
      { chapterNumber: 1, verseNumber: 1, text: 'Valid.' },
      {
        chapterNumber: 1,
        verseNumber: 2,
        text: 'Invalid.',
        markers: {
          headings: [
            { marker: 's1', text: 'One' },
            { marker: 's1', text: 'Two' },
            { marker: 's1', text: 'Three' },
            { marker: 's1', text: 'Four' },
            { marker: 's1', text: 'Five' },
          ],
        },
      },
    ]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('skips verses the source does not have instead of inventing rows', async () => {
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'materialized' });

    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, db);
    expect(logger.warn).toHaveBeenCalledWith('Imported USFM verses were skipped', {
      projectUnitId: 5,
      bookId: 1,
      unmatched: 1,
      empty: 0,
    });
  });

  it('logs imported verses that have no text', async () => {
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    expect(
      await materializeUsfmImport(row, 3, db, [{ chapterNumber: 1, verseNumber: 1, text: '' }])
    ).toEqual({ ok: true, data: 'materialized' });

    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, db);
    expect(logger.warn).toHaveBeenCalledWith('Imported USFM verses were skipped', {
      projectUnitId: 5,
      bookId: 1,
      unmatched: 0,
      empty: 1,
    });
  });
});

describe('materializePendingUsfmImports (#419)', () => {
  it('continues after an invalid stored file and still reports the failure', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: 'corrupted stored file' },
      { id: 2, projectUnitId: 5, bookId: 40, usfm: MAT },
    ]);
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    const result = await materializePendingUsfmImports(5, 3, [1, 40]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(inserted).toEqual([[{ projectUnitId: 5, bibleTextId: 101, content: 'The genealogy.' }]]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(2, db);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ importId: 1, projectUnitId: 5, bibleId: 3, bookId: 1 }),
      })
    );
  });

  it('continues after a per-book database failure and still reports the failure', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: GEN },
      { id: 2, projectUnitId: 5, bookId: 40, usfm: MAT },
    ]);
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);
    const failure = new Error('Import write failed');
    vi.mocked(db.insert).mockImplementationOnce(() => {
      throw failure;
    });

    const result = await materializePendingUsfmImports(5, 3, [1, 40]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
    expect(inserted).toEqual([[{ projectUnitId: 5, bibleTextId: 101, content: 'The genealogy.' }]]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(2, db);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        cause: failure,
        context: { importId: 1, projectUnitId: 5, bibleId: 3, bookId: 1 },
      })
    );
  });

  it('materializes independent books concurrently', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: GEN },
      { id: 2, projectUnitId: 5, bookId: 40, usfm: MAT },
    ]);
    rowsByTable.set(bible_texts, [{ id: 101, chapterNumber: 1, verseNumber: 1 }]);

    const releases: Array<() => void> = [];
    vi.mocked(repo.markUsfmImportMaterialized).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const resultPromise = materializePendingUsfmImports(5, 3, [1, 40]);
    await vi.waitFor(() => {
      expect(repo.markUsfmImportMaterialized).toHaveBeenCalledTimes(2);
    });

    for (const release of releases) release();

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      data: { materialized: 2, pending: 0 },
    });
  });

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

  it('reuses validation verses during creation and stores heading markers separately', async () => {
    const parse = vi.spyOn(converter, 'convertUSFMToUSJ');
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: GEN_WITH_HEADING },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: GEN_WITH_HEADING },
    ]);
    rowsByTable.set(bible_texts, [
      { id: 101, chapterNumber: 1, verseNumber: 1 },
      { id: 102, chapterNumber: 1, verseNumber: 2 },
    ]);

    const imported = await materializePendingUsfmImports(5, 3, [1], result.data);

    expect(imported).toEqual({ ok: true, data: { materialized: 1, pending: 0 } });
    expect(parse).toHaveBeenCalledTimes(1);
    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'First.' },
      {
        projectUnitId: 5,
        bibleTextId: 102,
        content: 'Second.',
        markers: { headings: [{ marker: 's1', text: 'The Creation' }] },
      },
    ]);
  });

  it('asks for nothing when there are no books', async () => {
    vi.mocked(repo.getPendingUsfmImports).mockResolvedValue([]);

    const result = await materializePendingUsfmImports(5, 3, []);

    expect(result).toEqual({ ok: true, data: { materialized: 0, pending: 0 } });
  });
});
