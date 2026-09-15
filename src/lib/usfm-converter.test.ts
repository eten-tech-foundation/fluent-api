import { describe, expect, it, vi } from 'vitest';

import type { VerseData } from './usfm-converter';

import { convertUSFMToUSJ, generateUSFMText } from './usfm-converter';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}));

const verse: VerseData = {
  bookId: 1,
  bookCode: 'GEN',
  bookName: 'Gênesis',
  chapterNumber: 1,
  verseNumber: 1,
  translatedContent: 'No princípio.',
};

describe('chapter assignment USFM conversion', () => {
  it('uses a numbered main title while preserving verses and chapter boundaries', () => {
    expect(
      generateUSFMText([
        verse,
        { ...verse, verseNumber: 2, translatedContent: null },
        { ...verse, chapterNumber: 2, translatedContent: 'Segundo capítulo.' },
      ])
    ).toBe(
      '\\id GEN\n' +
        '\\h Gênesis\n' +
        '\\mt1 Gênesis\n' +
        '\\c 1\n\\p\n' +
        '\\v 1 No princípio.\n' +
        '\\v 2 \n' +
        '\\c 2\n\\p\n' +
        '\\v 1 Segundo capítulo.\n\n'
    );
  });

  it('converts the generated title and verse to USJ', () => {
    const result = convertUSFMToUSJ(generateUSFMText([verse]));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          marker: 'mt1',
          content: [expect.stringMatching(/^Gênesis\s*$/)],
        }),
        expect.objectContaining({
          marker: 'p',
          content: [
            expect.objectContaining({ type: 'verse', number: '1' }),
            expect.stringMatching(/^No princípio\.\s*$/),
          ],
        }),
      ])
    );
  });

  it('still accepts an imported legacy main title', () => {
    const result = convertUSFMToUSJ('\\id GEN\n\\mt Gênesis\n\\c 1\n\\p\n\\v 1 No princípio.\n');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.content).toContainEqual(
      expect.objectContaining({ marker: 'mt', content: [expect.stringMatching(/^Gênesis\s*$/)] })
    );
  });
});
