import { describe, expect, it } from 'vitest';

import { err, ErrorCode, ok } from '@/lib/types';

import {
  anchorMatchesStart,
  coverageFromActive,
  parseAndValidatePericopeRange,
  rangesEqual,
  rangesOverlap,
} from './verse-audio.coverage';
import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

describe('verse-audio coverage', () => {
  describe('rangesEqual', () => {
    it('is true for identical inclusive bounds', () => {
      expect(
        rangesEqual(
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 3 } },
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 3 } }
        )
      ).toBe(true);
    });

    it('is false when either endpoint differs', () => {
      expect(
        rangesEqual(
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 3 } },
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 8 } }
        )
      ).toBe(false);
    });
  });

  describe('rangesOverlap', () => {
    it('detects overlapping ranges in the same chapter', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 5 } },
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 7 } }
        )
      ).toBe(true);
    });

    it('detects touching endpoints as overlap', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 3 } },
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 5 } }
        )
      ).toBe(true);
    });

    it('detects cross-chapter overlap', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 1, verse: 10 }, end: { chapter: 2, verse: 2 } },
          { start: { chapter: 2, verse: 1 }, end: { chapter: 2, verse: 5 } }
        )
      ).toBe(true);
    });

    it('returns false for non-overlapping ranges', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 2 } },
          { start: { chapter: 1, verse: 3 }, end: { chapter: 1, verse: 4 } }
        )
      ).toBe(false);
    });

    it('returns false when ranges are in different non-adjacent chapters', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 1, verse: 1 }, end: { chapter: 1, verse: 20 } },
          { start: { chapter: 3, verse: 1 }, end: { chapter: 3, verse: 5 } }
        )
      ).toBe(false);
    });

    it('treats single-point verse coverages as overlapping when equal', () => {
      expect(
        rangesOverlap(
          { start: { chapter: 3, verse: 4 }, end: { chapter: 3, verse: 4 } },
          { start: { chapter: 3, verse: 4 }, end: { chapter: 3, verse: 4 } }
        )
      ).toBe(true);
    });
  });

  describe('parseAndValidatePericopeRange', () => {
    it('accepts a valid same-chapter range', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 1,
          startVerse: 1,
          endChapter: 1,
          endVerse: 5,
        })
      ).toEqual(
        ok({
          start: { chapter: 1, verse: 1 },
          end: { chapter: 1, verse: 5 },
        })
      );
    });

    it('accepts a one-verse pericope (end equals start)', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 1,
          startVerse: 3,
          endChapter: 1,
          endVerse: 3,
        })
      ).toEqual(
        ok({
          start: { chapter: 1, verse: 3 },
          end: { chapter: 1, verse: 3 },
        })
      );
    });

    it('accepts a cross-chapter range', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 1,
          startVerse: 20,
          endChapter: 2,
          endVerse: 3,
        })
      ).toEqual(
        ok({
          start: { chapter: 1, verse: 20 },
          end: { chapter: 2, verse: 3 },
        })
      );
    });

    it('rejects a reversed range', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 1,
          startVerse: 5,
          endChapter: 1,
          endVerse: 2,
        })
      ).toEqual(err(ErrorCode.VALIDATION_ERROR));
    });

    it('rejects empty / zero / missing bounds', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 0,
          startVerse: 1,
          endChapter: 1,
          endVerse: 2,
        })
      ).toEqual(err(ErrorCode.VALIDATION_ERROR));

      expect(
        parseAndValidatePericopeRange({
          startChapter: 1,
          startVerse: 1,
          endChapter: 1,
          endVerse: undefined,
        })
      ).toEqual(err(ErrorCode.VALIDATION_ERROR));
    });

    it('rejects malformed non-integers', () => {
      expect(
        parseAndValidatePericopeRange({
          startChapter: 1.5,
          startVerse: 1,
          endChapter: 1,
          endVerse: 2,
        })
      ).toEqual(err(ErrorCode.VALIDATION_ERROR));
    });
  });

  describe('coverageFromActive', () => {
    it('uses stored pericope bounds', () => {
      expect(
        coverageFromActive(
          {
            granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
            startChapter: 1,
            startVerse: 2,
            endChapter: 1,
            endVerse: 8,
          },
          99,
          99
        )
      ).toEqual({
        start: { chapter: 1, verse: 2 },
        end: { chapter: 1, verse: 8 },
      });
    });

    it('uses bible_texts anchor for verse granularity', () => {
      expect(
        coverageFromActive(
          {
            granularity: VERSE_AUDIO_GRANULARITY.VERSE,
            startChapter: null,
            startVerse: null,
            endChapter: null,
            endVerse: null,
          },
          3,
          4
        )
      ).toEqual({
        start: { chapter: 3, verse: 4 },
        end: { chapter: 3, verse: 4 },
      });
    });
  });

  describe('anchorMatchesStart', () => {
    it('requires chapter and verse to match', () => {
      expect(anchorMatchesStart({ chapterNumber: 1, verseNumber: 2 }, 1, 2)).toBe(true);
      expect(anchorMatchesStart({ chapterNumber: 1, verseNumber: 2 }, 1, 3)).toBe(false);
      expect(anchorMatchesStart({ chapterNumber: 2, verseNumber: 2 }, 1, 2)).toBe(false);
    });
  });
});
