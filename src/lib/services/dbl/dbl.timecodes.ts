/**
 * Shared DBL / API.Bible audio timecode helpers used by source-audio and
 * playback-audio.
 *
 * Acceptance rules below are provisional: they unify the two domains' prior
 * parsers so both endpoints interpret the same provider strings the same way.
 * Authorized live API.Bible audio-chapter calls have so far returned zero
 * timecodes (see PR #380 discussion). When the first non-empty payload appears,
 * `warnIfAllDblTimecodesDropped` records raw samples so accepted formats can be
 * narrowed to observed shapes. Aquifer verse timestamps use a separate path.
 */

import { logger } from '@/lib/logger';

const DECIMAL_OR_CLOCK_SECONDS = /^\d+(?:\.\d+)?$/;
const CLOCK_PART = /^\d+$/;
const POSITIVE_VERSE = /^[1-9]\d*$/;

export interface DblTimecodeSample {
  start: string;
  verseId: string;
}

/**
 * Parse a DBL / API.Bible timecode `start`/`end` string to seconds.
 *
 * Provisionally accepted (trim applied):
 * - decimal seconds: `"0"`, `"4.5"`, `"9.0"`
 * - `MM:SS[.frac]`: `"00:00.0"`, `"00:05.120"`
 * - `HH:MM:SS[.frac]`: `"00:00:05.120"`
 *
 * Rejects non-finite results, out-of-range minutes/seconds (>= 60), and
 * malformed tokens.
 */
export function parseDblTimestampSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (!trimmed.includes(':')) {
    if (!DECIMAL_OR_CLOCK_SECONDS.test(trimmed)) return undefined;
    const decimal = Number(trimmed);
    return Number.isFinite(decimal) ? decimal : undefined;
  }

  const parts = trimmed.split(':');
  if (parts.length !== 2 && parts.length !== 3) return undefined;

  const secondsRaw = parts[parts.length - 1]!;
  const minuteRaw = parts[parts.length - 2]!;
  const hourRaw = parts.length === 3 ? parts[0]! : '0';

  if (
    !CLOCK_PART.test(hourRaw) ||
    !CLOCK_PART.test(minuteRaw) ||
    !DECIMAL_OR_CLOCK_SECONDS.test(secondsRaw)
  ) {
    return undefined;
  }

  const hours = Number(hourRaw);
  const minutes = Number(minuteRaw);
  const seconds = Number(secondsRaw);
  if (minutes >= 60 || seconds >= 60) return undefined;

  const offset = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(offset) ? offset : undefined;
}

/**
 * Parse a DBL / API.Bible `verseId` for the requested chapter.
 *
 * Requires `verseId` to start with `chapterPrefix` (e.g. `"JHN.3."`) and the
 * remaining suffix to be a positive decimal integer. Wrong-chapter IDs,
 * ranges, headings, and scientific/hex suffixes are rejected.
 */
export function parseDblVerseNumber(verseId: string, chapterPrefix: string): number | undefined {
  if (!verseId.startsWith(chapterPrefix)) return undefined;
  const suffix = verseId.slice(chapterPrefix.length);
  if (!POSITIVE_VERSE.test(suffix)) return undefined;
  const verse = Number(suffix);
  return Number.isSafeInteger(verse) ? verse : undefined;
}

/**
 * When a track supplies timecodes but the shared parser accepts none, log a
 * privacy-safe warning with audio Bible id, chapter, and up to three raw
 * `start`/`verseId` samples (no URLs or tokens). Missing, empty, or partially
 * accepted payloads do not warn.
 */
export function warnIfAllDblTimecodesDropped(params: {
  path: 'source-audio' | 'playback-audio';
  audioBibleId: string;
  chapter: string;
  timecodes: readonly DblTimecodeSample[] | null | undefined;
  acceptedCount: number;
}): void {
  const rows = params.timecodes;
  if (rows == null || rows.length === 0 || params.acceptedCount > 0) return;

  logger.warn({
    message: 'All DBL timecodes dropped by shared parser',
    context: {
      path: params.path,
      audioBibleId: params.audioBibleId,
      chapter: params.chapter,
      timecodeCount: rows.length,
      samples: rows.slice(0, 3).map((row) => ({ start: row.start, verseId: row.verseId })),
    },
  });
}
