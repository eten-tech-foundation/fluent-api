import { describe, expect, it } from 'vitest';

import { convertUSFMToUSJ, usjToVerseTexts } from './usfm-converter';

// Runs the real parser: these tests pin what usfm-grammar actually emits, not the type file.

const GENESIS = [
  '\\id GEN Genesis',
  '\\h Genesis',
  '\\mt1 Genesis',
  '\\c 1',
  '\\p',
  '\\v 1 In the beginning God created the heavens and the earth.',
  '\\v 2 The earth was \\nd formless\\nd* and empty.',
  '\\q1',
  '\\v 3-4 Bridged verse text.',
  '\\c 2',
  '\\p',
  '\\v 1 Chapter two.',
].join('\n');

function versesOf(usfm: string) {
  const usj = convertUSFMToUSJ(usfm);
  if (!usj.ok) throw new Error(usj.error.message);
  return usjToVerseTexts(usj.data);
}

describe('usjToVerseTexts (#419)', () => {
  it('yields one entry per verse with its chapter, across chapters', () => {
    expect(versesOf(GENESIS).map((v) => `${v.chapterNumber}:${v.verseNumber}`)).toEqual([
      '1:1',
      '1:2',
      '1:3',
      '2:1',
    ]);
  });

  it('keeps character-style text inline and trims the paragraph newline', () => {
    const verse = versesOf(GENESIS).find((v) => v.chapterNumber === 1 && v.verseNumber === 2);
    expect(verse?.text).toBe('The earth was formless and empty.');
  });

  it('files a bridged verse under its first number', () => {
    const verse = versesOf(GENESIS).find((v) => v.chapterNumber === 1 && v.verseNumber === 3);
    expect(verse?.text).toBe('Bridged verse text.');
  });

  it('leaves headings and titles out, since they belong to no verse', () => {
    const texts = versesOf(GENESIS).map((v) => v.text);
    expect(texts.some((t) => t.includes('Genesis'))).toBe(false);
  });

  it('carries a verse across a paragraph break rather than cutting it', () => {
    const verses = versesOf(
      '\\id GEN\n\\c 1\n\\p\n\\v 1 First half\n\\p\nsecond half.\n\\v 2 Next.'
    );
    expect(verses[0].text).toBe('First half second half.');
    expect(verses[1].text).toBe('Next.');
  });

  it('does not break on a tag Fluent does not know', () => {
    const verses = versesOf(
      '\\id GEN\n\\c 1\n\\p\n\\v 1 Known text.\n\\zcustom something\n\\v 2 After.'
    );
    expect(verses.map((v) => v.verseNumber)).toEqual([1, 2]);
  });

  it('returns nothing for a file with markers but no verses', () => {
    expect(versesOf('\\id GEN Genesis\n\\h Genesis')).toEqual([]);
  });
});
