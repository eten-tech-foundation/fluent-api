import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as booksService from '@/domains/books/books.service';
import { err, ErrorCode, ok } from '@/lib/types';

import { checkUsfmFiles, parseUsfmFiles } from './usfm-import.service';

vi.mock('@/domains/books/books.service', () => ({ getAllBooks: vi.fn() }));
vi.mock('@/domains/bible-books/bible-books.service', () => ({}));
vi.mock('@/domains/bibles/bible-texts/bible-texts.service', () => ({}));
vi.mock('@/domains/translated-verses/translated-verses.service', () => ({}));
vi.mock('./projects.repository', () => ({}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const BOOKS = [
  { id: 1, code: 'GEN', eng_display_name: 'Genesis' },
  { id: 13, code: '1CH', eng_display_name: '1 Chronicles' },
  { id: 31, code: 'OBA', eng_display_name: 'Obadiah' },
  { id: 57, code: 'PHM', eng_display_name: 'Philemon' },
];

const BODY = '\\c 1\n\\p\n\\v 1 The vision of Obadiah.\n\\v 2 Behold.';
const OBA = `\\id OBA\n${BODY}`;
const PHM = '\\id PHM\n\\c 1\n\\p\n\\v 1 Paul, a prisoner.';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(booksService.getAllBooks).mockResolvedValue(
    ok(BOOKS.map((book) => ({ ...book, updatedAt: null })))
  );
});

describe('checkUsfmFiles (#418, #419)', () => {
  it('reports each file with the book it is for, in upload order', async () => {
    const result = await checkUsfmFiles([
      { fileName: 'PHM.usfm', usfm: PHM },
      { fileName: 'OBA.usfm', usfm: OBA },
    ]);

    expect(result).toEqual(
      ok([
        { fileName: 'PHM.usfm', ok: true, bookCode: 'PHM', bookName: 'Philemon' },
        { fileName: 'OBA.usfm', ok: true, bookCode: 'OBA', bookName: 'Obadiah' },
      ])
    );
  });

  it('reads the book from \\toc3 or \\mt names when \\id is missing', async () => {
    const result = await checkUsfmFiles([
      { fileName: 'toc3.usfm', usfm: `\\h Obadiah\n\\toc3 Obad\n${BODY}` },
      { fileName: 'mt.usfm', usfm: `\\h Philemon\n\\mt1 Philemon\n${BODY}` },
      {
        fileName: '1CH-hin2017.usfm',
        usfm: `\\h 1 इतिहास\n\\toc1 इतिहास की पहली पुस्तक\n\\toc3 1 इति.\n\\mt1 इतिहास की पहली पुस्तक\n${BODY}`,
      },
    ]);

    expect(result.ok && result.data.map((file) => file.ok && file.bookCode)).toEqual([
      'OBA',
      'PHM',
      '1CH',
    ]);
  });

  it('takes the book from \\id, whatever the file is called (#419)', async () => {
    const result = await checkUsfmFiles([{ fileName: '1CH.usfm', usfm: `\\id GEN\n${BODY}` }]);

    expect(result).toEqual(
      ok([{ fileName: '1CH.usfm', ok: true, bookCode: 'GEN', bookName: 'Genesis' }])
    );
  });

  it.each([
    ['a verse before its chapter', '\\id OBA\n\\p\n\\v 1 The vision.\n\\c 1\n\\p\n\\v 2 Behold.'],
    ['no chapter', '\\id OBA\n\\p\n\\v 1 The vision.'],
    ['\\id after another marker', '\\h Obadiah\n\\id OBA\n\\c 1\n\\p\n\\v 1 The vision.'],
    ['no verses', '\\id OBA\n\\c 1\n\\p The vision.'],
    ['a chapter without a number', '\\id OBA\n\\c\n\\p\n\\v 1 The vision.'],
    ['a verse without a number', '\\id OBA\n\\c 1\n\\p\n\\v The vision.'],
  ])('rejects a file with %s as not valid USFM', async (_, usfm) => {
    const result = await checkUsfmFiles([{ fileName: 'broken.usfm', usfm }]);

    expect(result).toEqual(
      ok([
        {
          fileName: 'broken.usfm',
          ok: false,
          error: 'USFM_INVALID',
          message: 'File is not valid USFM',
        },
      ])
    );
  });

  it('tells a file with no markers apart from one with no book', async () => {
    const result = await checkUsfmFiles([
      { fileName: 'notes.txt', usfm: 'just a note' },
      { fileName: 'empty.usfm', usfm: '' },
      { fileName: 'nobook.usfm', usfm: `\\h Tobit\n\\toc3 Tob\n${BODY}` },
    ]);

    expect(result.ok && result.data.map((file) => !file.ok && file.error)).toEqual([
      'USFM_INVALID',
      'USFM_INVALID',
      'USFM_BOOK_MISSING',
    ]);
    expect(result.ok && result.data[2]).toMatchObject({ message: 'Missing book data' });
  });

  it('flags every file after the first that is for the same book', async () => {
    const result = await checkUsfmFiles([
      { fileName: 'OBA.usfm', usfm: OBA },
      { fileName: 'OBA-copy.usfm', usfm: OBA },
    ]);

    expect(result.ok && result.data[0]).toMatchObject({ ok: true, bookCode: 'OBA' });
    expect(result.ok && result.data[1]).toEqual({
      fileName: 'OBA-copy.usfm',
      ok: false,
      error: 'USFM_BOOK_DUPLICATE',
      message: 'Another file in this upload is for the same book',
    });
  });

  it('passes on a failure to read the books', async () => {
    vi.mocked(booksService.getAllBooks).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const result = await checkUsfmFiles([{ fileName: 'OBA.usfm', usfm: OBA }]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
  });

  it('accepts at creation the book it reported at upload', async () => {
    const files = [
      { fileName: 'toc3.usfm', usfm: `\\toc3 Obad\n${BODY}` },
      { fileName: 'hin.usfm', usfm: `\\toc3 1 इति.\n${BODY}` },
    ];
    const checked = await checkUsfmFiles(files);
    if (!checked.ok) throw new Error('check failed');

    const created = await parseUsfmFiles(
      checked.data.map((file, index) => ({
        ...files[index],
        bookCode: file.ok ? file.bookCode : '',
      }))
    );

    expect(created.ok && created.data.map((file) => [file.bookCode, file.bookId])).toEqual([
      ['OBA', 31],
      ['1CH', 13],
    ]);
  });
});
