import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as booksService from '@/domains/books/books.service';
import * as translatedVersesService from '@/domains/translated-verses/translated-verses.service';
import { ErrorCode, ok } from '@/lib/types';

import * as repo from './projects.repository';
import { parseUsfmFiles } from './usfm-import.service';

vi.mock('@/domains/books/books.service', () => ({ getAllBooks: vi.fn() }));
vi.mock('@/domains/bible-books/bible-books.service', () => ({}));
vi.mock('@/domains/bibles/bible-texts/bible-texts.service', () => ({}));
vi.mock('@/domains/translated-verses/translated-verses.service', () => ({
  importTranslatedVerses: vi.fn(),
}));
vi.mock('./projects.repository', () => ({ markUsfmImportMaterialized: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const GEN = '\\id GEN Genesis\n\\c 1\n\\p\n\\v 1 In the beginning.\n\\v 2 The earth.';
const GEN_WITH_HEADING =
  '\\id GEN\n\\c 1\n\\p\n\\v 1 First.\n\\s1 The Creation\n\\p\n\\v 2 Second.';
const MAT = '\\id MAT Matthew\n\\c 1\n\\p\n\\v 1 The genealogy.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(booksService.getAllBooks).mockResolvedValue(
    ok([
      { id: 1, code: 'GEN', eng_display_name: 'Genesis' },
      { id: 40, code: 'MAT', eng_display_name: 'Matthew' },
    ])
  );
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

  it('keeps a trailing heading in the raw file without adding it to the previous verse', async () => {
    const usfm = `${GEN}\n\\s1 Appendix`;
    const result = await parseUsfmFiles([{ fileName: 'gen.usfm', bookCode: 'GEN', usfm }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].usfm).toBe(usfm);
    expect(result.data[0].verses.at(-1)).toEqual({
      chapterNumber: 1,
      verseNumber: 2,
      text: 'The earth.',
    });
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

  it('rejects a file without any usable book marker', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: '\\c 1\n\\p\n\\v 1 Text without a book.' },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISSING } });
  });

  it.each([
    '\\toc3 GEN',
    '\\mt GEN',
    '\\mt1 GEN',
    '\\id ZZZ\n\\toc3 GEN',
    '\\id\n\\toc3 GEN',
    '\\toc3 invalid\n\\mt1 GEN',
  ])('accepts the client book fallback %s and keeps the original file', async (header) => {
    const usfm = `${header}\n\\c 1\n\\p\n\\v 1 Original.`;
    const result = await parseUsfmFiles([{ fileName: 'gen.usfm', bookCode: 'GEN', usfm }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0]).toMatchObject({
      bookId: 1,
      bookCode: 'GEN',
      usfm,
      verses: [{ text: 'Original.' }],
    });
  });

  it('rejects a fallback that disagrees with the claimed book', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: '\\toc3 MAT\n\\c 1\n\\p\n\\v 1 Text.' },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISMATCH } });
  });

  it.each([
    ['too many headings', Array.from({ length: 5 }, () => '\\s1 Heading').join('\n')],
    ['overlong heading', `\\s1 ${'x'.repeat(301)}`],
  ])('rejects %s at creation before saving an import', async (_label, heading) => {
    const result = await parseUsfmFiles([
      {
        fileName: 'gen.usfm',
        bookCode: 'GEN',
        usfm: `\\id GEN\n\\c 1\n${heading}\n\\p\n\\v 1 Text.`,
      },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
    expect(translatedVersesService.importTranslatedVerses).not.toHaveBeenCalled();
    expect(repo.markUsfmImportMaterialized).not.toHaveBeenCalled();
  });

  it('rejects malformed files even when the other files parse', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'gen.usfm', bookCode: 'GEN', usfm: GEN },
      {
        fileName: 'mat.usfm',
        bookCode: 'MAT',
        usfm: '\\id MAT\n\\c 1\n\\sd1 Invalid text\n\\p\n\\v 1 Body.',
      },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_INVALID } });
  });

  it('preserves unsupported tags in the raw file without contaminating editable text', async () => {
    const usfm = `${GEN}\n\\li1 List apparatus.\n\\p\n\\v 3 Third.\n\\zcustom custom data\n\\s1 Trailing heading`;
    const result = await parseUsfmFiles([{ fileName: 'gen.usfm', bookCode: 'GEN', usfm }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data[0].usfm).toBe(usfm);
    expect(result.data[0].verses.map((verse) => verse.text)).toEqual([
      'In the beginning.',
      'The earth.',
      'Third.',
    ]);
  });

  it('rejects two files for the same book', async () => {
    const result = await parseUsfmFiles([
      { fileName: 'a.usfm', bookCode: 'GEN', usfm: GEN },
      { fileName: 'b.usfm', bookCode: 'gen', usfm: GEN },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.USFM_BOOK_MISMATCH } });
  });
});
