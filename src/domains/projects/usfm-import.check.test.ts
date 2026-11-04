import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as bibleBooksService from '@/domains/bible-books/bible-books.service';
import * as booksService from '@/domains/books/books.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './projects.repository';
import { parseUsfmFiles, prepareUsfmImport } from './usfm-import.service';

vi.mock('@/domains/books/books.service', () => ({ getAllBooks: vi.fn() }));
vi.mock('@/domains/bible-books/bible-books.service', () => ({ getBibleBooksByBibleId: vi.fn() }));
vi.mock('@/domains/bibles/bible-texts/bible-texts.service', () => ({}));
vi.mock('@/domains/translated-verses/translated-verses.service', () => ({}));
vi.mock('./projects.repository', () => ({ getProjectBookPlacements: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const BOOKS = [
  { id: 1, code: 'GEN', eng_display_name: 'Genesis' },
  { id: 2, code: 'EXO', eng_display_name: 'Exodus' },
  { id: 13, code: '1CH', eng_display_name: '1 Chronicles' },
  { id: 31, code: 'OBA', eng_display_name: 'Obadiah' },
  { id: 40, code: 'MAT', eng_display_name: 'Matthew' },
  { id: 57, code: 'PHM', eng_display_name: 'Philemon' },
];
// The source Bible has every book above but Philemon.
const SOURCE_BOOK_IDS = [1, 2, 13, 31, 40];
const TARGET = { projectId: 10, sourceBibleId: 7 };

const BODY = '\\c 1\n\\p\n\\v 1 The vision of Obadiah.\n\\v 2 Behold.';
const OBA = `\\id OBA\n${BODY}`;
const file = (fileName: string, usfm: string) => ({ fileName, usfm });

type Placement = Awaited<ReturnType<typeof repo.getProjectBookPlacements>>[number];
const placement = (bookId: number, milestoneName: string, removed = false): Placement => ({
  bookId,
  milestoneName,
  deletedAt: removed ? new Date('2026-10-01T00:00:00Z') : null,
});

/** A source-Bible book row, as GET /bible-books/bible/{id} lists it. */
const sourceBook = ({ id, code, eng_display_name }: (typeof BOOKS)[number]) => ({
  bibleId: 7,
  bookId: id,
  hasAudio: false,
  createdAt: null,
  updatedAt: null,
  book: { id, code, eng_display_name },
  bible: { id: 7, name: 'IRV Gujarati' },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(booksService.getAllBooks).mockResolvedValue(
    ok(BOOKS.map((book) => ({ ...book, updatedAt: null })))
  );
  vi.mocked(bibleBooksService.getBibleBooksByBibleId).mockResolvedValue(
    ok(BOOKS.filter((book) => SOURCE_BOOK_IDS.includes(book.id)).map(sourceBook))
  );
  vi.mocked(repo.getProjectBookPlacements).mockResolvedValue([]);
});

describe('prepareUsfmImport (#418, #419)', () => {
  it('accepts each file with the book it is for, in upload order', async () => {
    const result = await prepareUsfmImport(TARGET, [
      file('MAT.usfm', `\\id MAT\n${BODY}`),
      file('OBA.usfm', OBA),
    ]);

    expect(result.ok && result.data.verdicts).toEqual([
      { fileName: 'MAT.usfm', ok: true, bookCode: 'MAT', bookName: 'Matthew' },
      { fileName: 'OBA.usfm', ok: true, bookCode: 'OBA', bookName: 'Obadiah' },
    ]);
    expect(result.ok && result.data.accepted.map((f) => [f.bookCode, f.bookId])).toEqual([
      ['MAT', 40],
      ['OBA', 31],
    ]);
  });

  it('reads the book from \\toc3 or \\mt names when \\id is missing', async () => {
    const result = await prepareUsfmImport(TARGET, [
      file('toc3.usfm', `\\h Obadiah\n\\toc3 Obad\n${BODY}`),
      file('mt.usfm', `\\mt1 Matthew\n${BODY}`),
      file(
        '1CH-hin2017.usfm',
        `\\h 1 इतिहास\n\\toc1 इतिहास की पहली पुस्तक\n\\toc3 1 इति.\n\\mt1 इतिहास की पहली पुस्तक\n${BODY}`
      ),
    ]);

    expect(result.ok && result.data.verdicts.map((v) => v.ok && v.bookCode)).toEqual([
      'OBA',
      'MAT',
      '1CH',
    ]);
  });

  it('checks a file with blank lines (\\b) and the files sent after it (fluent-web#418)', async () => {
    const result = await prepareUsfmImport(TARGET, [
      file(
        'GEN.usfm',
        '\\id GEN\n\\c 1\n\\q1\n\\v 1 In the beginning.\n\\b\n\\q1\n\\v 2 The earth.'
      ),
      file('OBA.usfm', OBA),
    ]);

    expect(result.ok && result.data.verdicts).toEqual([
      { fileName: 'GEN.usfm', ok: true, bookCode: 'GEN', bookName: 'Genesis' },
      { fileName: 'OBA.usfm', ok: true, bookCode: 'OBA', bookName: 'Obadiah' },
    ]);
  });

  it('reads list header and footer lines into their verses, with headings and blank lines in the list (fluent-web#418)', async () => {
    // The layout of a genealogy in Biblica's Open Telugu Contemporary Version (Genesis 10). Most
    // of its list lines carry a verse; a few have words of their own (Genesis 22, 35, 36).
    const usfm = [
      '\\id GEN',
      '\\c 10',
      '\\s1 The table of nations',
      '\\lh',
      '\\v 1 This is the account of the sons of Noah.',
      '\\s2 The Japhethites',
      '\\li1',
      '\\v 2 The sons of Japheth:',
      '\\li2 Gomer and Magog.',
      '\\lf These were the sons of Japheth.',
      '\\b',
      '\\lf',
      '\\v 3 These are the clans.',
      '\\c 11',
      '\\p',
      '\\v 1 The whole world had one language.',
    ].join('\n');

    const result = await prepareUsfmImport(TARGET, [file('GEN.usfm', usfm)]);

    expect(result.ok && result.data.verdicts).toEqual([
      { fileName: 'GEN.usfm', ok: true, bookCode: 'GEN', bookName: 'Genesis' },
    ]);
    const [accepted] = result.ok ? result.data.accepted : [];
    // The file is stored as it came; only the parser reads the list lines as paragraphs.
    expect(accepted.usfm).toBe(usfm);
    expect(accepted.verses.map((v) => [`${v.chapterNumber}:${v.verseNumber}`, v.text])).toEqual([
      ['10:1', 'This is the account of the sons of Noah.'],
      ['10:2', 'The sons of Japheth: Gomer and Magog. These were the sons of Japheth.'],
      ['10:3', 'These are the clans.'],
      ['11:1', 'The whole world had one language.'],
    ]);
    // The footer's own words stay in their verse, as a plain paragraph after the list items.
    expect(accepted.verses[1].markers?.paragraphs?.map((p) => p.marker)).toEqual([
      'li1',
      'li2',
      'p',
    ]);
  });

  it('reads a cross reference left open inside a footnote (fluent-web#418)', async () => {
    const usfm =
      '\\id GEN\n\\c 1\n\\p\n\\v 1 In the beginning.\\f + \\fr 1:1 \\ft See\\xt 3\\ft and\\xt 4\\ft .\\f*\n\\v 2 The earth.';

    const result = await prepareUsfmImport(TARGET, [file('GEN.usfm', usfm)]);

    expect(result.ok && result.data.verdicts).toEqual([
      { fileName: 'GEN.usfm', ok: true, bookCode: 'GEN', bookName: 'Genesis' },
    ]);
    const [accepted] = result.ok ? result.data.accepted : [];
    expect(accepted.usfm).toBe(usfm);
    expect(accepted.verses.map((v) => v.text)).toEqual(['In the beginning.', 'The earth.']);
  });

  it('takes the book from \\id, whatever the file is called (#419)', async () => {
    const result = await prepareUsfmImport(TARGET, [file('1CH.usfm', `\\id GEN\n${BODY}`)]);

    expect(result.ok && result.data.verdicts).toEqual([
      { fileName: '1CH.usfm', ok: true, bookCode: 'GEN', bookName: 'Genesis' },
    ]);
  });

  it.each([
    ['a verse before its chapter', '\\id OBA\n\\p\n\\v 1 The vision.\n\\c 1\n\\p\n\\v 2 Behold.'],
    ['no chapter', '\\id OBA\n\\p\n\\v 1 The vision.'],
    ['\\id after another marker', '\\h Obadiah\n\\id OBA\n\\c 1\n\\p\n\\v 1 The vision.'],
    ['no verses', '\\id OBA\n\\c 1\n\\p The vision.'],
    ['a chapter without a number', '\\id OBA\n\\c\n\\p\n\\v 1 The vision.'],
    ['a verse without a number', '\\id OBA\n\\c 1\n\\p\n\\v The vision.'],
  ])('refuses a file with %s as not valid USFM', async (_, usfm) => {
    const result = await prepareUsfmImport(TARGET, [file('broken.usfm', usfm)]);

    expect(result.ok && result.data.verdicts).toEqual([
      {
        fileName: 'broken.usfm',
        ok: false,
        error: 'USFM_INVALID',
        message: 'File is not a valid USFM file.',
      },
    ]);
    expect(result.ok && result.data.accepted).toEqual([]);
  });

  it('tells a file with no markers apart from one with no book', async () => {
    const result = await prepareUsfmImport(TARGET, [
      file('notes.txt', 'just a note'),
      file('nobook.usfm', `\\h Tobit\n\\toc3 Tob\n${BODY}`),
    ]);

    expect(result.ok && result.data.verdicts).toEqual([
      {
        fileName: 'notes.txt',
        ok: false,
        error: 'USFM_INVALID',
        message: 'File is not a valid USFM file.',
      },
      {
        fileName: 'nobook.usfm',
        ok: false,
        error: 'USFM_BOOK_MISSING',
        message: 'Missing book data.',
      },
    ]);
  });

  it('refuses a second file for a book already in the upload or already listed', async () => {
    const result = await prepareUsfmImport(
      TARGET,
      [file('OBA.usfm', OBA), file('OBA-copy.usfm', OBA), file('GEN.usfm', `\\id GEN\n${BODY}`)],
      ['gen']
    );

    expect(result.ok && result.data.verdicts.slice(1)).toEqual([
      {
        fileName: 'OBA-copy.usfm',
        ok: false,
        error: 'USFM_BOOK_DUPLICATE',
        message: 'Obadiah was already added.',
        bookCode: 'OBA',
        bookName: 'Obadiah',
      },
      {
        fileName: 'GEN.usfm',
        ok: false,
        error: 'USFM_BOOK_DUPLICATE',
        message: 'Genesis was already added.',
        bookCode: 'GEN',
        bookName: 'Genesis',
      },
    ]);
    expect(result.ok && result.data.accepted.map((f) => f.fileName)).toEqual(['OBA.usfm']);
  });

  it('refuses a book the project holds, naming its milestone or the project', async () => {
    vi.mocked(repo.getProjectBookPlacements).mockResolvedValue([
      placement(40, 'Gospels'),
      placement(2, 'Torah', true),
      // A book removed from one milestone and active in another is reported where it is active.
      placement(1, 'Old', true),
      placement(1, 'Beginnings'),
    ]);

    const result = await prepareUsfmImport(TARGET, [
      file('MAT.usfm', `\\id MAT\n${BODY}`),
      file('EXO.usfm', `\\id EXO\n${BODY}`),
      file('GEN.usfm', `\\id GEN\n${BODY}`),
    ]);

    expect(result.ok && result.data.verdicts).toEqual([
      expect.objectContaining({
        error: 'USFM_BOOK_EXISTS',
        message: 'Matthew already exists in Gospels.',
        milestoneName: 'Gospels',
      }),
      expect.objectContaining({
        error: 'USFM_BOOK_EXISTS',
        message: 'Exodus already exists in this project.',
        milestoneName: null,
      }),
      expect.objectContaining({
        error: 'USFM_BOOK_EXISTS',
        message: 'Genesis already exists in Beginnings.',
        milestoneName: 'Beginnings',
      }),
    ]);
    expect(result.ok && result.data.accepted).toEqual([]);
  });

  it("refuses a book the project's Source Bible does not have", async () => {
    const result = await prepareUsfmImport(TARGET, [
      file('PHM.usfm', '\\id PHM\n\\c 1\n\\p\n\\v 1 Paul.'),
    ]);

    expect(result.ok && result.data.verdicts).toEqual([
      {
        fileName: 'PHM.usfm',
        ok: false,
        error: 'USFM_BOOK_NOT_IN_SOURCE',
        message: 'Philemon is not in IRV Gujarati.',
        bookCode: 'PHM',
        bookName: 'Philemon',
        sourceBibleName: 'IRV Gujarati',
      },
    ]);
  });

  it('passes on a failure to read what it checks against', async () => {
    vi.mocked(booksService.getAllBooks).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const result = await prepareUsfmImport(TARGET, [file('OBA.usfm', OBA)]);

    expect(result).toMatchObject({ ok: false, error: { code: ErrorCode.INTERNAL_ERROR } });
  });

  it('reports a book that project creation accepts too', async () => {
    const files = [
      file('toc3.usfm', `\\toc3 Obad\n${BODY}`),
      file('hin.usfm', `\\toc3 1 इति.\n${BODY}`),
    ];
    const checked = await prepareUsfmImport(TARGET, files);
    if (!checked.ok) throw new Error('check failed');

    const created = await parseUsfmFiles(
      checked.data.accepted.map(({ fileName, usfm, bookCode }) => ({ fileName, usfm, bookCode }))
    );

    expect(created.ok && created.data.map((f) => [f.bookCode, f.bookId])).toEqual([
      ['OBA', 31],
      ['1CH', 13],
    ]);
  });
});
