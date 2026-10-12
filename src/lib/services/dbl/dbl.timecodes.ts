/**
 * Shared DBL / API.Bible audio timecode helpers used by source-audio and
 * playback-audio.
 *
 * Acceptance rules below are provisional: they unify the two domains' prior
 * parsers so both endpoints interpret the same provider strings the same way.
 * They are not yet backed by captured live API.Bible `timecodes` payloads in
 * this repo (see docs/features/source-audio/design.md). When genuine responses
 * are recorded, tighten fixtures and regexes to the observed shapes only.
 */

const DECIMAL_SECONDS = /^\d+(?:\.\d+)?$/;
const CLOCK_PART = /^\d+$/;
const CLOCK_SECONDS = /^\d+(?:\.\d+)?$/;
const POSITIVE_VERSE = /^[1-9]\d*$/;

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
    if (!DECIMAL_SECONDS.test(trimmed)) return undefined;
    const decimal = Number(trimmed);
    return Number.isFinite(decimal) ? decimal : undefined;
  }

  const parts = trimmed.split(':');
  if (parts.length !== 2 && parts.length !== 3) return undefined;

  const secondsRaw = parts[parts.length - 1]!;
  const minuteRaw = parts[parts.length - 2]!;
  const hourRaw = parts.length === 3 ? parts[0]! : '0';

  if (!CLOCK_PART.test(hourRaw) || !CLOCK_PART.test(minuteRaw) || !CLOCK_SECONDS.test(secondsRaw)) {
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
