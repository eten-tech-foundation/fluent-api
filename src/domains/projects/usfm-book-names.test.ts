import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BOOK_NAMES, bookCodeFromName, normalizeBookName } from './usfm-book-names';

// The 66 codes the books table is seeded with, read the way the seed reads them.
const seeded = JSON.parse(
  readFileSync(new URL('../../db/seeds/data/books.json', import.meta.url), 'utf-8')
) as { books: { code: string }[] };
const KNOWN = new Set(seeded.books.map((book) => book.code));

describe('the book names table', () => {
  it('lists every one of the 66 books and no other code', () => {
    expect(Object.keys(BOOK_NAMES).sort()).toEqual([...KNOWN].sort());
  });

  it('never gives two books the same name', () => {
    const owners = new Map<string, string[]>();
    for (const [code, names] of Object.entries(BOOK_NAMES)) {
      for (const name of names) {
        const key = normalizeBookName(name);
        owners.set(key, [...new Set([...(owners.get(key) ?? []), code])]);
      }
    }
    const shared = [...owners].filter(([, codes]) => codes.length > 1);
    expect(shared).toEqual([]);
  });

  it('never lists a name that is itself a code, since codes are matched first', () => {
    const codeLike = Object.values(BOOK_NAMES)
      .flat()
      .filter((name) => KNOWN.has(name.trim().toUpperCase()));
    expect(codeLike).toEqual([]);
  });
});

describe('bookCodeFromName (#418 fallback)', () => {
  it.each([
    ['1ch', '1CH'],
    ['oba', 'OBA'],
    ['JON', 'JON'],
    ['GEN Genesis', 'GEN'],
  ])('reads %j as a code first', (text, code) => {
    expect(bookCodeFromName(text, KNOWN)).toBe(code);
  });

  it.each([
    ['Obad', 'OBA'],
    ['Obadiah', 'OBA'],
    ['Phlm', 'PHM'],
    ['Philemon', 'PHM'],
    ['1 Chr', '1CH'],
    ['1 Chronicles', '1CH'],
    ['First Chronicles', '1CH'],
    ['I Samuel', '1SA'],
    ['II Kings', '2KI'],
    ['Song of Songs', 'SNG'],
    ['The Book of Jonah', 'JON'],
    ['The Gospel According to St. John', 'JHN'],
    ['The First Epistle of Paul to the Corinthians', '1CO'],
    ['Revelation of John', 'REV'],
    ['  psalms  ', 'PSA'],
  ])('reads the English name %j', (text, code) => {
    expect(bookCodeFromName(text, KNOWN)).toBe(code);
  });

  it.each([
    // eBible hin2017
    ['1 इति.', '1CH'],
    ['इतिहास की पहली पुस्तक', '1CH'],
    ['उत्प.', 'GEN'],
    ['ओब.', 'OBA'],
    ['1कुरि.', '1CO'],
    ['फिलेमोन के नाम प्रेरित पौलुस की पत्री', 'PHM'],
    // Door43 hi_irv
    ['1 इतिहास', '1CH'],
    ['ओबद्याह', 'OBA'],
    ['कुरिन्थ की कलीसिया को लिखा गया पौलुस का पहला पत्र', '1CO'],
  ])('reads the Hindi IRV name %j', (text, code) => {
    expect(bookCodeFromName(text, KNOWN)).toBe(code);
  });

  it('treats spacing, a trailing period and Devanagari digits alike', () => {
    expect(bookCodeFromName('1 कुरि', KNOWN)).toBe('1CO');
    expect(bookCodeFromName('१ इतिहास', KNOWN)).toBe('1CH');
    expect(bookCodeFromName('1इति', KNOWN)).toBe('1CH');
  });

  it.each(['', 'Tobit', 'Genesiss', 'The Book', '1', 'Chronicles'])(
    'finds no book in %j',
    (text) => {
      expect(bookCodeFromName(text, KNOWN)).toBeUndefined();
    }
  );

  it('only answers with a book the caller knows', () => {
    expect(bookCodeFromName('Obadiah', new Set(['GEN']))).toBeUndefined();
    expect(bookCodeFromName('oba', new Set(['GEN']))).toBeUndefined();
  });
});
