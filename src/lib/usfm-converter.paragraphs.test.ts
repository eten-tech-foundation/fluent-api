import { describe, expect, it, vi } from 'vitest';

import type { VerseMarkers } from '@/db/schema';
import type { USJDocument, USJNode } from '@/lib/types';

import { MAX_VERSE_PARAGRAPHS } from '@/db/schema';
import { logger } from '@/lib/logger';

import { generateUSFMText, usjToVerseTexts } from './usfm-converter';
import { versesOf } from './usfm-converter.test-fixtures';

type VerseParagraphs = NonNullable<NonNullable<VerseMarkers>['paragraphs']>;

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

// Runs the real parser, like usfm-converter.usj-verses.test.ts.

describe('paragraph structure (fluent-web#314)', () => {
  it('records which verses open a paragraph', () => {
    expect(versesOf('\\id JHN\n\\c 3\n\\p\n\\v 1 One.\n\\v 2 Two.\n\\p\n\\v 3 Three.')).toEqual([
      {
        chapterNumber: 3,
        verseNumber: 1,
        text: 'One.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      },
      { chapterNumber: 3, verseNumber: 2, text: 'Two.' },
      {
        chapterNumber: 3,
        verseNumber: 3,
        text: 'Three.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      },
    ]);
  });

  it('records a paragraph opening inside a verse at its offset in the saved text', () => {
    const verses = versesOf(
      '\\id JHN\n\\c 3\n\\p\n\\v 4 First half,\n\\p and its second half.\n\\v 5 Five.'
    );
    expect(verses).toEqual([
      {
        chapterNumber: 3,
        verseNumber: 4,
        text: 'First half, and its second half.',
        markers: {
          paragraphs: [
            { marker: 'p', offset: 0 },
            { marker: 'p', offset: 12 },
          ],
        },
      },
      { chapterNumber: 3, verseNumber: 5, text: 'Five.' },
    ]);
    expect(verses[0].text.slice(12)).toBe('and its second half.');
  });

  it('keeps poetry lines, including one that continues a verse', () => {
    expect(
      versesOf('\\id PSA\n\\c 1\n\\q1\n\\v 1 Line one,\n\\q2 line two.\n\\q1\n\\v 2 Line three.')
    ).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'Line one, line two.',
        markers: {
          paragraphs: [
            { marker: 'q1', offset: 0 },
            { marker: 'q2', offset: 10 },
          ],
        },
      },
      {
        chapterNumber: 1,
        verseNumber: 2,
        text: 'Line three.',
        markers: { paragraphs: [{ marker: 'q1', offset: 0 }] },
      },
    ]);
  });

  it('opens the verse in the paragraph its words start in when the number stands alone', () => {
    expect(versesOf('\\id PSA\n\\c 1\n\\q1\n\\v 1\n\\q2 Words.')).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'Words.',
        markers: { paragraphs: [{ marker: 'q2', offset: 0 }] },
      },
    ]);
  });

  it('keeps the heading and the paragraph of the verse below it', () => {
    expect(versesOf('\\id JHN\n\\c 3\n\\s1 Jesus and Nicodemus\n\\p\n\\v 1 One.')).toEqual([
      {
        chapterNumber: 3,
        verseNumber: 1,
        text: 'One.',
        markers: {
          headings: [{ marker: 's1', text: 'Jesus and Nicodemus' }],
          paragraphs: [{ marker: 'p', offset: 0 }],
        },
      },
    ]);
  });

  it('leaves words before any open verse in the raw file and warns about them', () => {
    const verses = versesOf(
      '\\id JHN\n\\c 3\n\\s1 Jesus and Nicodemus\n\\p Before any verse.\n\\p\n\\v 1 One.'
    );

    expect(verses).toEqual([
      {
        chapterNumber: 3,
        verseNumber: 1,
        text: 'One.',
        markers: {
          headings: [{ marker: 's1', text: 'Jesus and Nicodemus' }],
          paragraphs: [{ marker: 'p', offset: 0 }],
        },
      },
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      'Imported USFM text before a verse stays only in the raw file',
      { chapters: [3], characters: 'Before any verse.'.length }
    );
  });

  it('keeps the first paragraphs a row can store, and every word, and warns about the rest', () => {
    const words = Array.from({ length: MAX_VERSE_PARAGRAPHS + 2 }, (_, i) => `w${i}`);
    const breaks = words.slice(1).map((word) => `\\p ${word}`);
    const [verse] = versesOf(`\\id JHN\n\\c 3\n\\p\n\\v 1 ${words[0]}\n${breaks.join('\n')}`);

    expect(verse.text).toBe(words.join(' '));
    const paragraphs = verse.markers?.paragraphs ?? [];
    expect(paragraphs).toHaveLength(MAX_VERSE_PARAGRAPHS);
    expect(verse.text.slice(paragraphs[MAX_VERSE_PARAGRAPHS - 1].offset)).toMatch(
      new RegExp(`^w${MAX_VERSE_PARAGRAPHS - 1} `)
    );
    expect(logger.warn).toHaveBeenCalledWith('Imported USFM verse kept only its first paragraphs', {
      chapterNumber: 3,
      verseNumber: 1,
      paragraphs: MAX_VERSE_PARAGRAPHS + 2,
      kept: MAX_VERSE_PARAGRAPHS,
    });
  });

  it('exports the imported paragraphs back where the file had them', () => {
    const usfm = [
      '\\id JHN',
      '\\c 3',
      '\\s1 Jesus and Nicodemus',
      '\\p',
      '\\v 1 One.',
      '\\v 2 Two.',
      '\\p',
      '\\v 3 Three, first half,',
      '\\p and its second half.',
      '\\q1',
      '\\v 4 Poetry line,',
      '\\q2 still verse four.',
      '\\p',
      '\\v 5 Five.',
    ].join('\n');
    const imported = versesOf(usfm);
    const exported = generateUSFMText(
      imported.map((verse) => ({
        bookId: 43,
        bookCode: 'JHN',
        bookName: 'John',
        chapterNumber: verse.chapterNumber,
        verseNumber: verse.verseNumber,
        translatedContent: verse.text,
        markers: verse.markers,
      }))
    );

    expect(versesOf(exported)).toEqual(imported);
  });
});

// The USFM spec's \p followed by \q: a paragraph that starts with a poetry line.
describe('an empty \\p before a poetry line (fluent-web#530)', () => {
  const opensWithPoetry = (verseNumber: number, text: string, more: VerseParagraphs = []) => ({
    chapterNumber: 1,
    verseNumber,
    text,
    markers: {
      paragraphs: [{ marker: 'p', offset: 0 }, { marker: 'q1', offset: 0 }, ...more],
    },
  });

  it('keeps the \\p for the verse whose line comes right after it', () => {
    expect(
      versesOf('\\id MRK\n\\c 1\n\\p\n\\v 1 One.\n\\p\n\\q1\n\\v 2 Two,\n\\q2 still two.')
    ).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'One.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      },
      opensWithPoetry(2, 'Two, still two.', [{ marker: 'q2', offset: 5 }]),
    ]);
  });

  it('keeps it at the start of a chapter and after a heading', () => {
    expect(versesOf('\\id PSA\n\\c 1\n\\p\n\\q1\n\\v 1 One.')).toEqual([
      opensWithPoetry(1, 'One.'),
    ]);
    const [verse] = versesOf('\\id PSA\n\\c 1\n\\s1 A song\n\\p\n\\q1\n\\v 1 One.');
    expect(verse.markers).toEqual({
      headings: [{ marker: 's1', text: 'A song' }],
      ...opensWithPoetry(1, 'One.').markers,
    });
  });

  // Kasey and CodeRabbit on fluent-api#473: words before the first verse are left out of the rows,
  // but they still mean the paragraph is not empty, and that the line does not open with \v.
  it('keeps no \\p when the paragraph before the line holds words', () => {
    expect(versesOf('\\id PSA\n\\c 1\n\\p Introductory text.\n\\q1\n\\v 1 One.')).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'One.',
        markers: { paragraphs: [{ marker: 'q1', offset: 0 }] },
      },
    ]);
  });

  it('keeps no \\p when the line holds words before its verse number', () => {
    expect(versesOf('\\id PSA\n\\c 1\n\\p\n\\q1 Label words\n\\v 1 One.')).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'One.',
        markers: { paragraphs: [{ marker: 'q1', offset: 0 }] },
      },
    ]);
  });

  it.each<[string, USJNode]>([
    ['a character marker', { type: 'char', marker: 'nd', content: ['Lord'] }],
    ['a verse number', { type: 'verse', marker: 'v', number: '1' }],
    ['stray text', 'Stray words.' as unknown as USJNode],
    ['an unknown block', { type: 'table', content: [] } as unknown as USJNode],
  ])('keeps no \\p when %s comes between it and the line', (_, between) => {
    const usj: USJDocument = {
      type: 'USJ',
      version: '3.1',
      content: [
        { type: 'chapter', marker: 'c', number: '1' },
        { type: 'para', marker: 'p', content: [] },
        between,
        {
          type: 'para',
          marker: 'q1',
          content: [{ type: 'verse', marker: 'v', number: '2' }, 'Two.'],
        },
      ],
    };
    const result = usjToVerseTexts(usj);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.find((verse) => verse.verseNumber === 2)?.markers).toEqual({
      paragraphs: [{ marker: 'q1', offset: 0 }],
    });
  });

  it('drops an empty paragraph anywhere else, as before', () => {
    // Before a line a verse only continues into, before another \p, and an empty \q1.
    expect(
      versesOf(
        '\\id PSA\n\\c 1\n\\q1\n\\v 1 One,\n\\p\n\\q2 still one.\n\\p\n\\p\n\\v 2 Two.\n\\q1\n\\p\n\\v 3 Three.'
      )
    ).toEqual([
      {
        chapterNumber: 1,
        verseNumber: 1,
        text: 'One, still one.',
        markers: {
          paragraphs: [
            { marker: 'q1', offset: 0 },
            { marker: 'q2', offset: 5 },
          ],
        },
      },
      {
        chapterNumber: 1,
        verseNumber: 2,
        text: 'Two.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      },
      {
        chapterNumber: 1,
        verseNumber: 3,
        text: 'Three.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      },
    ]);
  });

  it('exports it back where the file had it', () => {
    const usfm =
      '\\id MRK\n\\c 1\n\\p\n\\v 1 One.\n\\p\n\\q1\n\\v 2 Two,\n\\q2 still two.\n\\p\n\\v 3 Three.';
    const imported = versesOf(usfm);
    const exported = generateUSFMText(
      imported.map((verse) => ({
        bookId: 41,
        bookCode: 'MRK',
        bookName: 'Mark',
        chapterNumber: verse.chapterNumber,
        verseNumber: verse.verseNumber,
        translatedContent: verse.text,
        markers: verse.markers,
      }))
    );

    expect(exported).toContain(
      '\\v 1 One.\n\\p\n\\q1\n\\v 2 Two, \n\\q2\nstill two.\n\\p\n\\v 3 Three.'
    );
    expect(versesOf(exported)).toEqual(imported);
  });
});
