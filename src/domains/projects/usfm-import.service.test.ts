import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateTranslatedVerseInput } from '@/domains/translated-verses/translated-verses.types';

import * as bibleBooksService from '@/domains/bible-books/bible-books.service';
import * as bibleTextsService from '@/domains/bibles/bible-texts/bible-texts.service';
import * as booksService from '@/domains/books/books.service';
import * as translatedVersesService from '@/domains/translated-verses/translated-verses.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import * as converter from '@/lib/usfm-converter';

import * as repo from './projects.repository';
import {
  materializePendingUsfmImports,
  materializePendingUsfmImportsForBible,
  materializeUsfmImport,
  parseUsfmFiles,
} from './usfm-import.service';

// The parser is real. Persistence is mocked at repository and public domain service seams.
const inserted: CreateTranslatedVerseInput[][] = [];
vi.mock('@/domains/books/books.service', () => ({ getAllBooks: vi.fn(), getBookById: vi.fn() }));
vi.mock('@/domains/bible-books/bible-books.service', () => ({ isBibleBookTextIngested: vi.fn() }));
vi.mock('@/domains/bibles/bible-texts/bible-texts.service', () => ({
  getBibleBookVerseReferences: vi.fn(),
}));
vi.mock('@/domains/translated-verses/translated-verses.service', () => ({
  importTranslatedVerses: vi.fn(),
}));

vi.mock('./projects.repository', () => ({
  getPendingUsfmImports: vi.fn(),
  getPendingUsfmImportsForBible: vi.fn(),
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
  inserted.length = 0;
  const books = [
    { id: 1, code: 'GEN', eng_display_name: 'Genesis' },
    { id: 40, code: 'MAT', eng_display_name: 'Matthew' },
  ];
  vi.mocked(booksService.getAllBooks).mockResolvedValue(ok(books));
  vi.mocked(booksService.getBookById).mockImplementation(async (id) => {
    const book = books.find((book) => book.id === id);
    return book ? ok(book) : err(ErrorCode.BOOK_NOT_FOUND);
  });
  vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(ok([]));
  vi.mocked(translatedVersesService.importTranslatedVerses).mockImplementation(async (rows) => {
    inserted.push(rows);
    return ok(undefined);
  });
  vi.mocked(bibleBooksService.isBibleBookTextIngested).mockResolvedValue(ok(true));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('materializeUsfmImport (#419)', () => {
  const row = { id: 9, projectUnitId: 5, bookId: 1, usfm: GEN };

  it('waits for confirmed book completion even when some source verses already exist', async () => {
    vi.mocked(bibleBooksService.isBibleBookTextIngested).mockResolvedValue(ok(false));
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'pending' });
    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();

    vi.mocked(bibleBooksService.isBibleBookTextIngested).mockResolvedValue(ok(true));
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'materialized' });
    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
      { projectUnitId: 5, bibleTextId: 102, content: 'The earth.' },
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, undefined);
  });

  it('reports pending and writes nothing while the source text is not ingested', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(ok([]));

    const result = await materializeUsfmImport(row, 3);

    expect(result).toEqual({ ok: true, data: 'pending' });
    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('attaches each verse to its source row once the text exists', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

    const result = await materializeUsfmImport(row, 3);

    expect(result).toEqual({ ok: true, data: 'materialized' });
    expect(inserted).toEqual([
      [
        { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
        { projectUnitId: 5, bibleTextId: 102, content: 'The earth.' },
      ],
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledWith(9, undefined);
  });

  it('reparses a delayed import and stores heading markers separately from content', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

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

  it('materializes a stored fallback file without rewriting its original text', async () => {
    const usfm = '\\toc3 GEN\n\\c 1\n\\p\n\\v 1 Original.';
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );
    expect(await materializeUsfmImport({ ...row, usfm }, 3)).toEqual(ok('materialized'));
    expect(inserted).toEqual([[{ projectUnitId: 5, bibleTextId: 101, content: 'Original.' }]]);
    expect(booksService.getBookById).toHaveBeenCalledWith(1);
  });

  it('keeps a failed domain write pending and returns its error', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );
    vi.mocked(translatedVersesService.importTranslatedVerses).mockResolvedValueOnce(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(await materializeUsfmImport(row, 3)).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('propagates source lookup failure instead of reporting pending', async () => {
    vi.mocked(bibleBooksService.isBibleBookTextIngested).mockResolvedValueOnce(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(await materializeUsfmImport(row, 3)).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(bibleTextsService.getBibleBookVerseReferences).not.toHaveBeenCalled();
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('stores an empty verse when it carries a heading', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

    const result = await materializeUsfmImport(row, 3, undefined, [
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

    expect(await materializeUsfmImport(row, 3)).toEqual({ ok: true, data: 'materialized' });

    expect(inserted[0]).toEqual([
      { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
    ]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, undefined);
    expect(logger.warn).toHaveBeenCalledWith('Imported USFM verses were skipped', {
      projectUnitId: 5,
      bookId: 1,
      unmatched: 1,
      empty: 0,
    });
  });

  it('logs imported verses that have no text', async () => {
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

    expect(
      await materializeUsfmImport(row, 3, undefined, [
        { chapterNumber: 1, verseNumber: 1, text: '' },
      ])
    ).toEqual({ ok: true, data: 'materialized' });

    expect(inserted).toEqual([]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(9, undefined);
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

    const result = await materializePendingUsfmImports(5, 3, [1, 40]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(inserted).toEqual([[{ projectUnitId: 5, bibleTextId: 101, content: 'The genealogy.' }]]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(2, undefined);
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );
    const failure = new Error('Import write failed');
    vi.mocked(translatedVersesService.importTranslatedVerses).mockRejectedValueOnce(failure);

    const result = await materializePendingUsfmImports(5, 3, [1, 40]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
    expect(inserted).toEqual([[{ projectUnitId: 5, bibleTextId: 101, content: 'The genealogy.' }]]);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledExactlyOnceWith(2, undefined);
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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

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
    // Both books have a source verse; references are scoped by the service call.
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

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
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

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

describe('materializePendingUsfmImportsForBible (#419)', () => {
  it('finishes every project waiting on the book, not only the one whose job ingested it', async () => {
    vi.mocked(repo.getPendingUsfmImportsForBible).mockResolvedValue([
      { id: 1, projectUnitId: 5, bookId: 1, usfm: GEN },
      { id: 2, projectUnitId: 6, bookId: 1, usfm: GEN },
    ]);
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([
        { id: 101, chapterNumber: 1, verseNumber: 1 },
        { id: 102, chapterNumber: 1, verseNumber: 2 },
      ])
    );

    const result = await materializePendingUsfmImportsForBible(3, [1]);

    expect(result).toEqual({ ok: true, data: { materialized: 2, pending: 0 } });
    expect(repo.getPendingUsfmImportsForBible).toHaveBeenCalledWith(3, [1]);
    expect(inserted.flat()).toEqual(
      expect.arrayContaining([
        { projectUnitId: 5, bibleTextId: 101, content: 'In the beginning.' },
        { projectUnitId: 6, bibleTextId: 101, content: 'In the beginning.' },
      ])
    );
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledWith(1, undefined);
    expect(repo.markUsfmImportMaterialized).toHaveBeenCalledWith(2, undefined);
  });

  it('reports the failure against the project unit that owns the import', async () => {
    vi.mocked(repo.getPendingUsfmImportsForBible).mockResolvedValue([
      { id: 7, projectUnitId: 6, bookId: 1, usfm: 'corrupted stored file' },
    ]);
    vi.mocked(bibleTextsService.getBibleBookVerseReferences).mockResolvedValue(
      ok([{ id: 101, chapterNumber: 1, verseNumber: 1 }])
    );

    const result = await materializePendingUsfmImportsForBible(3, [1]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ importId: 7, projectUnitId: 6, bibleId: 3, bookId: 1 }),
      })
    );
  });

  it('asks for nothing when no book completed', async () => {
    vi.mocked(repo.getPendingUsfmImportsForBible).mockResolvedValue([]);

    const result = await materializePendingUsfmImportsForBible(3, []);

    expect(result).toEqual({ ok: true, data: { materialized: 0, pending: 0 } });
  });
});
