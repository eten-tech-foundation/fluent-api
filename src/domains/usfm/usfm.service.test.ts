import { describe, expect, it } from 'vitest';

import type { BookFields, VerseData } from './usfm.types';

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

function book(overrides: Partial<BookFields> = {}): BookFields {
  return {
    runningHeader: null,
    bookTitle: null,
    tocLongName: null,
    tocShortName: null,
    tocAbbreviation: null,
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
      tocLongName: null,
      tocShortName: null,
      tocAbbreviation: null,
    });
    expect(withFields).toContain('\\h Gênesis\n');
    expect(withFields).toContain('\\mt O Primeiro Livro de Moisés\n');

    const withNulls = await renderUSFM([verse({})], {
      runningHeader: null,
      bookTitle: null,
      tocLongName: null,
      tocShortName: null,
      tocAbbreviation: null,
    });
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

  it('emits a heading block before the verse it precedes', async () => {
    const usfm = await renderUSFM([
      verse({
        markers: {
          headings: [{ marker: 's1', text: 'The Creation' }],
          paragraphs: [{ marker: 'p', offset: 0 }],
        },
      }),
    ]);

    expect(usfm).toContain('\\c 1\n\\s1 The Creation\n\\p\n\\v 1 In the beginning.\n');
  });

  it('emits several headings in the order they were stored', async () => {
    const usfm = await renderUSFM([
      verse({
        markers: {
          headings: [
            { marker: 'ms1', text: 'Book One' },
            { marker: 's1', text: 'The Creation' },
          ],
        },
      }),
    ]);

    expect(usfm).toContain('\\ms1 Book One\n\\s1 The Creation\n');
  });

  it('keeps the chapter default paragraph when a heading opens the chapter', async () => {
    // The heading is not a paragraph: the verse after it still needs one.
    const usfm = await renderUSFM([
      verse({ markers: { headings: [{ marker: 's1', text: 'The Creation' }] } }),
    ]);

    expect(usfm).toContain('\\c 1\n\\s1 The Creation\n\\p\n\\v 1 In the beginning.\n');
  });

  it('puts a mid-chapter heading before that verse, not at the chapter top', async () => {
    const usfm = await renderUSFM([
      verse({ verseNumber: 1 }),
      verse({
        verseNumber: 2,
        translatedContent: 'Second verse.',
        markers: {
          headings: [{ marker: 's1', text: 'A Later Section' }],
          paragraphs: [{ marker: 'p', offset: 0 }],
        },
      }),
    ]);

    expect(usfm).toContain(
      '\\v 1 In the beginning.\n\\s1 A Later Section\n\\p\n\\v 2 Second verse.\n'
    );
  });

  // ─── fluent-web#398: table-of-contents fields ──────────────────────────────

  it('renders a #263-era row (book fields, no TOC) exactly as before', async () => {
    // The population this change actually puts at risk. A full-document `toBe`,
    // so a stray \toc line slipping in between \h and \mt fails here.
    const usfm = await renderUSFM(
      [verse({})],
      book({ runningHeader: 'Gênesis', bookTitle: 'O Primeiro Livro de Moisés' })
    );

    expect(usfm).toBe(
      '\\id GEN\n' +
        '\\h Gênesis\n' +
        '\\mt O Primeiro Livro de Moisés\n' +
        '\\c 1\n\\p\n' +
        '\\v 1 In the beginning.\n' +
        '\n'
    );
  });

  it('emits the toc block between \\h and \\mt', async () => {
    // Order is grammar-enforced, not cosmetic: usfm-grammar rejects a \toc line
    // that follows \mt. One contiguous substring pins presence and order at once.
    const usfm = await renderUSFM(
      [verse({})],
      book({
        runningHeader: 'Gênesis',
        bookTitle: 'O Primeiro Livro de Moisés',
        tocLongName: 'Gênesis',
        tocShortName: 'Gênesis',
        tocAbbreviation: 'Gn',
      })
    );

    expect(usfm).toContain('\\h Gênesis\n\\toc1 Gênesis\n\\toc2 Gênesis\n\\toc3 Gn\n\\mt ');
  });

  it('omits a toc line when its field is null or blank', async () => {
    // Nothing downstream rejects an empty `\toc1 ` line — it parses, and becomes a
    // silent empty para in USJ/USX — so this test is the only guard against one.
    const onlyShort = await renderUSFM([verse({})], book({ tocShortName: 'Gênesis' }));
    expect(onlyShort).toContain('\\toc2 Gênesis\n');
    expect(onlyShort).not.toContain('\\toc1');
    expect(onlyShort).not.toContain('\\toc3');

    const none = await renderUSFM([verse({})], book());
    expect(none).not.toContain('\\toc');

    const blank = await renderUSFM([verse({})], book({ tocLongName: '   ', tocShortName: '' }));
    expect(blank).not.toContain('\\toc');
  });

  it('emits the trimmed toc value', async () => {
    // Trailing whitespace otherwise survives into the parsed USJ content.
    const usfm = await renderUSFM([verse({})], book({ tocAbbreviation: '  Gn  ' }));

    expect(usfm).toContain('\\toc3 Gn\n');
  });

  it('\\mt prefers the short name without destroying the authored book title', async () => {
    const withBoth = await renderUSFM(
      [verse({})],
      book({ bookTitle: 'O Primeiro Livro de Moisés', tocShortName: 'Gênesis' })
    );
    expect(withBoth).toContain('\\mt Gênesis\n');

    // Clearing the short name reveals the preserved legacy \mt again, rather than
    // falling through to the display name: a TOC edit never rewrites book_title.
    const shortCleared = await renderUSFM(
      [verse({})],
      book({ bookTitle: 'O Primeiro Livro de Moisés', tocShortName: null })
    );
    expect(shortCleared).toContain('\\mt O Primeiro Livro de Moisés\n');
  });

  it('\\h falls back to the short name before the display name', async () => {
    // So a vernacular project does not export an English running header beside a
    // vernacular \toc2.
    const borrowed = await renderUSFM(
      [verse({})],
      book({ runningHeader: null, tocShortName: 'Gênesis' })
    );
    expect(borrowed).toContain('\\h Gênesis\n');

    const authored = await renderUSFM(
      [verse({})],
      book({ runningHeader: 'Gênesis', tocShortName: 'Genesis' })
    );
    expect(authored).toContain('\\h Gênesis\n');
  });
});
