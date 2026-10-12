/**
 * Shared DBL / API.Bible audio timecode helpers used by source-audio and
 * playback-audio.
 *
 * Acceptance rules below are provisional: they unify the two domains' prior
 * parsers so both endpoints interpret the same provider strings the same way.
 * Authorized live API.Bible audio-chapter calls have so far returned zero
 * timecodes (see PR #380 discussion). When the first non-empty payload appears,
 * `warnIfAllDblTimecodesDropped` logs allowlisted, length-capped samples so
 * accepted formats can be narrowed to observed shapes. Aquifer verse timestamps
 * use a separate path.
 */

import { logger } from '@/lib/logger';

const DECIMAL_OR_CLOCK_SECONDS = /^\d+(?:\.\d+)?$/;
const CLOCK_PART = /^\d+$/;
const POSITIVE_VERSE = /^[1-9]\d*$/;

/** Provisional format evidence only: decimal seconds or clock parts. */
const SAFE_START_SAMPLE = /^[0-9.:]+$/;
/** Verse-id shaped tokens (e.g. BOOK.CH.V); no query/URL punctuation. */
const SAFE_VERSE_ID_SAMPLE = /^[a-z0-9.]+$/i;
const SAFE_AUDIO_BIBLE_ID = /^[\w.-]+$/;
const SAFE_CHAPTER_ID = /^[a-z0-9.]+$/i;

const MAX_SAMPLE_ROWS = 3;
const MAX_FIELD_CHARS = 48;
const MAX_SAMPLES_PAYLOAD_CHARS = 240;

const REDACTED = '[redacted]';
const INVALID_TYPE = '[invalid-type]';

export interface DblTimecodeSample {
  start: string;
  verseId: string;
}

export interface DblTimecodeDiagnosticSample {
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

function looksCredentialLike(value: string): boolean {
  return (
    /https?:\/\/|\/\/|www\./i.test(value) ||
    /[?&#%=/\\]/.test(value) ||
    /bearer\s|token|secret|password|signature|credential|x-amz-|api[_-]?key/i.test(value)
  );
}

function sanitizeDiagnosticField(
  value: unknown,
  allow: RegExp,
  maxChars: number = MAX_FIELD_CHARS
): string {
  if (typeof value !== 'string') return INVALID_TYPE;
  const trimmed = value.trim();
  if (!trimmed) return REDACTED;
  if (looksCredentialLike(trimmed) || !allow.test(trimmed)) return REDACTED;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

/**
 * Build allowlisted, length-capped diagnostic samples for logging.
 * Rejects URLs, query/credential punctuation, and non-strings; keeps only
 * provisional format-evidence shapes (clock/decimal start, dotted verse ids).
 */
export function sanitizeDblTimecodeDiagnosticSamples(
  timecodes: readonly unknown[]
): DblTimecodeDiagnosticSample[] {
  const samples: DblTimecodeDiagnosticSample[] = [];
  for (const row of timecodes.slice(0, MAX_SAMPLE_ROWS)) {
    const record =
      row !== null && typeof row === 'object' ? (row as Record<string, unknown>) : undefined;
    samples.push({
      start: sanitizeDiagnosticField(record?.start, SAFE_START_SAMPLE),
      verseId: sanitizeDiagnosticField(record?.verseId, SAFE_VERSE_ID_SAMPLE),
    });
    if (JSON.stringify(samples).length > MAX_SAMPLES_PAYLOAD_CHARS) {
      samples.pop();
      break;
    }
  }
  return samples;
}

/**
 * When a track supplies timecodes but the shared parser accepts none, log a
 * warning with audio Bible id, chapter, and up to three allowlisted
 * `start`/`verseId` samples (length-capped; URLs/tokens/non-strings redacted).
 * Missing, empty, or partially accepted payloads do not warn.
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
      audioBibleId: sanitizeDiagnosticField(params.audioBibleId, SAFE_AUDIO_BIBLE_ID),
      chapter: sanitizeDiagnosticField(params.chapter, SAFE_CHAPTER_ID),
      timecodeCount: rows.length,
      samples: sanitizeDblTimecodeDiagnosticSamples(rows),
    },
  });
}
