import type { Result } from '@/lib/types';

import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioGranularity } from './verse-audio.types';

import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

export interface VerseRef {
  chapter: number;
  verse: number;
}

export interface RangeCoverage {
  start: VerseRef;
  end: VerseRef;
}

interface ActiveCoverageRecord {
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
}

/** Lexicographic (chapter, verse) ordering. */
function compareVerseRef(a: VerseRef, b: VerseRef): number {
  if (a.chapter !== b.chapter) {
    return a.chapter - b.chapter;
  }
  return a.verse - b.verse;
}

/** Inclusive ranges overlap when each starts at or before the other ends. */
export function rangesOverlap(a: RangeCoverage, b: RangeCoverage): boolean {
  return compareVerseRef(a.start, b.end) <= 0 && compareVerseRef(b.start, a.end) <= 0;
}

/** True when both ranges share the same inclusive start and end. */
export function rangesEqual(a: RangeCoverage, b: RangeCoverage): boolean {
  return compareVerseRef(a.start, b.start) === 0 && compareVerseRef(a.end, b.end) === 0;
}

/**
 * Active coverage for conflict scanning. Pericope uses stored bounds; verse is a
 * single point at the bible_texts anchor (stored range columns stay null).
 */
export function coverageFromActive(
  record: ActiveCoverageRecord,
  anchorChapter: number,
  anchorVerse: number
): RangeCoverage {
  if (
    record.granularity === VERSE_AUDIO_GRANULARITY.PERICOPE &&
    record.startChapter != null &&
    record.startVerse != null &&
    record.endChapter != null &&
    record.endVerse != null
  ) {
    return {
      start: { chapter: record.startChapter, verse: record.startVerse },
      end: { chapter: record.endChapter, verse: record.endVerse },
    };
  }

  return {
    start: { chapter: anchorChapter, verse: anchorVerse },
    end: { chapter: anchorChapter, verse: anchorVerse },
  };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validates a pericope range: all four bounds positive integers, end >= start
 * (same chapter or a later chapter).
 */
export function parseAndValidatePericopeRange(input: {
  startChapter: unknown;
  startVerse: unknown;
  endChapter: unknown;
  endVerse: unknown;
}): Result<RangeCoverage> {
  const { startChapter, startVerse, endChapter, endVerse } = input;

  if (
    !isPositiveInt(startChapter) ||
    !isPositiveInt(startVerse) ||
    !isPositiveInt(endChapter) ||
    !isPositiveInt(endVerse)
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  const start: VerseRef = { chapter: startChapter, verse: startVerse };
  const end: VerseRef = { chapter: endChapter, verse: endVerse };

  if (compareVerseRef(end, start) < 0) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

  return ok({ start, end });
}

/** True when the bible_texts anchor equals the pericope range start (product rule). */
export function anchorMatchesStart(
  bibleText: { chapterNumber: number; verseNumber: number },
  startChapter: number,
  startVerse: number
): boolean {
  return bibleText.chapterNumber === startChapter && bibleText.verseNumber === startVerse;
}
