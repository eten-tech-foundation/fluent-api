import { describe, expect, it, vi } from 'vitest';

import { MAX_VERSE_PARAGRAPHS } from '@/db/schema';
import { logger } from '@/lib/logger';

import { convertUSFMToUSJ, generateUSFMText, usjToVerseTexts } from './usfm-converter';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

// Runs the real parser, like usfm-converter.usj-verses.test.ts.

function versesOf(usfm: string) {
  const usj = convertUSFMToUSJ(usfm);
  if (!usj.ok) throw new Error(usj.error.message);
  const verses = usjToVerseTexts(usj.data);
  if (!verses.ok) throw new Error(verses.error.message);
  return verses.data;
}

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
