import { describe, expect, it } from 'vitest';

import type { VerseData } from './usfm.types';

import { createUSFMStreamForBook } from './usfm.service';

async function renderUSFM(
  verses: VerseData[],
  book?: Parameters<typeof createUSFMStreamForBook>[1]
) {
  const chunks: string[] = [];
  for await (const chunk of createUSFMStreamForBook(verses, book)) {
    chunks.push(String(chunk));
  }
  return chunks.join('');
}

function verse(overrides: Partial<VerseData>): VerseData {
  return {
    bookId: 1,
    bookCode: 'GEN',
    bookName: 'Genesis',
    chapterNumber: 1,
    verseNumber: 1,
    translatedContent: 'In the beginning.',
    markers: null,
    ...overrides,
  };
}

describe('createUSFMStreamForBook', () => {
  it('renders legacy rows (no markers) exactly as before', async () => {
    const usfm = await renderUSFM([
      verse({ verseNumber: 1 }),
      verse({ verseNumber: 2, translatedContent: 'Second verse.' }),
      verse({ chapterNumber: 2, verseNumber: 1, translatedContent: 'Next chapter.' }),
    ]);

    expect(usfm).toBe(
      '\\id GEN\n' +
        '\\h Genesis\n' +
        '\\mt Genesis\n' +
        '\\c 1\n\\p\n' +
        '\\v 1 In the beginning.\n' +
        '\\v 2 Second verse.\n' +
        '\\c 2\n\\p\n' +
        '\\v 1 Next chapter.\n' +
        '\n'
    );
  });

  it('a verse that opens a paragraph replaces the default \\p after \\c', async () => {
    const usfm = await renderUSFM([
      verse({ markers: { paragraphs: [{ marker: 'q1', offset: 0 }] } }),
    ]);

    expect(usfm).toContain('\\c 1\n\\q1\n\\v 1 In the beginning.\n');
    expect(usfm).not.toContain('\\p');
  });

  it('a mid-chapter verse that opens a paragraph gets its marker before \\v', async () => {
    const usfm = await renderUSFM([
      verse({ verseNumber: 1 }),
      verse({
        verseNumber: 2,
        translatedContent: 'Second verse.',
        markers: { paragraphs: [{ marker: 'p', offset: 0 }] },
      }),
    ]);

    expect(usfm).toContain('\\v 1 In the beginning.\n\\p\n\\v 2 Second verse.\n');
  });

  it('splits a verse across paragraphs at a mid-text offset', async () => {
    const content = 'First part second part.';
    const usfm = await renderUSFM([
      verse({
        translatedContent: content,
        // "First part " is 11 chars; the new paragraph opens at "second".
        markers: { paragraphs: [{ marker: 'q2', offset: 11 }] },
      }),
    ]);

    expect(usfm).toContain('\\v 1 First part \n\\q2\nsecond part.\n');
  });

  it('keeps the default \\p when the first verse of the chapter has no opening marker', async () => {
    const usfm = await renderUSFM([
      verse({ verseNumber: 1 }),
      verse({
        verseNumber: 2,
        translatedContent: 'Poetry line.',
        markers: { paragraphs: [{ marker: 'q1', offset: 0 }] },
      }),
    ]);

    expect(usfm).toContain('\\c 1\n\\p\n\\v 1 In the beginning.\n\\q1\n\\v 2 Poetry line.\n');
  });

  it('ignores offsets beyond the verse content instead of corrupting the output', async () => {
    const usfm = await renderUSFM([
      verse({
        translatedContent: 'Short.',
        markers: { paragraphs: [{ marker: 'p', offset: 999 }] },
      }),
    ]);

    expect(usfm).toContain('\\c 1\n\\p\n\\v 1 Short.\n');
  });

  it('prefers authored book fields over the display name, with fallback', async () => {
    const withFields = await renderUSFM([verse({})], {
      runningHeader: 'Gênesis',
      bookTitle: 'O Primeiro Livro de Moisés',
    });
    expect(withFields).toContain('\\h Gênesis\n');
    expect(withFields).toContain('\\mt O Primeiro Livro de Moisés\n');

    const withNulls = await renderUSFM([verse({})], { runningHeader: null, bookTitle: null });
    expect(withNulls).toContain('\\h Genesis\n');
    expect(withNulls).toContain('\\mt Genesis\n');
  });

  it('renders an untranslated verse with an opening marker without inventing text', async () => {
    // A non-default marker, so the assertion fails if the stored marker is
    // ignored and the chapter falls back to its hardcoded \p.
    const usfm = await renderUSFM([
      verse({
        translatedContent: null,
        markers: { paragraphs: [{ marker: 'q1', offset: 0 }] },
      }),
    ]);

    expect(usfm).toContain('\\c 1\n\\q1\n\\v 1 \n');
    expect(usfm).not.toContain('\\p');
  });
});
