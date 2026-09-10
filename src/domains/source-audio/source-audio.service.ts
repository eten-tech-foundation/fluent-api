import type { BibleAudioResponse } from '@/domains/bibles/bible-audio/bible-audio.types';
import type { Bible } from '@/domains/bibles/bibles.types';
import type { UsfmBookCode } from '@/domains/translation-resources/translation-resources.types';
import type {
  AquiferBible,
  AquiferBibleTextResponse,
  AquiferMediaFile,
} from '@/lib/services/aquifer/aquifer.types';
import type { Result } from '@/lib/types';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { logger } from '@/lib/logger';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { ErrorCode, ok } from '@/lib/types';

import type {
  SourceAudioItem,
  SourceAudioManifestResponse,
  SourceAudioProvider,
  SourceAudioResponse,
} from './source-audio.types';

interface SourceAudioVerseTimestamp {
  verse: number;
  startSeconds?: number;
  endSeconds?: number;
  dblAudioBibleId?: string;
}

interface ChapterSourceAudioInput {
  languageCode: string;
  fluentBibleId: number;
  bookCode: UsfmBookCode;
  chapter: number;
  verse?: number;
}

interface SourceAudioManifestInput {
  projectId: number;
  languageCode: string;
  fluentBibleId: number;
  bookCode: UsfmBookCode;
  startChapter: number;
  endChapter: number;
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Resolve the Fluent Bible to an Aquifer one.
 *
 * `bibles.aquifer_bible_id` is the concrete peg: when it is set AND resolves against the
 * candidate list, it wins outright, so an operator can pin a Bible to a specific Aquifer
 * publication instead of relying on the name/abbreviation heuristic below.
 *
 * Everything else is unchanged on purpose. A NULL column -- which is every row that predates
 * this feature -- takes exactly the path it always did, and a set-but-unresolvable id also
 * falls through rather than short-circuiting to "no audio". That keeps this a pure addition:
 * no input that has a defined result today gets a different one. Whether an explicitly-pinned
 * Bible SHOULD refuse to guess is a real question, but it is a change to the pre-existing
 * fallback's semantics and belongs with whoever owns the callers of that behaviour -- the warn
 * below exists so that conversation can start from evidence rather than suspicion.
 */
export function matchAquiferBible(
  fluentBible: Bible,
  candidates: AquiferBible[]
): AquiferBible | undefined {
  return (
    matchAquiferBibleByPin(fluentBible, candidates) ??
    matchAquiferBibleByHeuristic(fluentBible, candidates)
  );
}

/** Rung 1: resolve only the explicit pin, without guessing a different publication. */
export function matchAquiferBibleByPin(
  fluentBible: Bible,
  candidates: AquiferBible[]
): AquiferBible | undefined {
  if (candidates.length === 0) return undefined;

  if (fluentBible.aquiferBibleId !== null && fluentBible.aquiferBibleId !== undefined) {
    const byPinnedId = candidates.find((b) => b.id === fluentBible.aquiferBibleId);
    if (byPinnedId) return byPinnedId;
    logger.warn({
      message:
        'Bible pins an aquiferBibleId that is not in the Aquifer catalogue for this language; ' +
        'falling back to name matching',
      context: {
        fluentBibleId: fluentBible.id,
        aquiferBibleId: fluentBible.aquiferBibleId,
        candidateIds: candidates.map((b) => b.id),
      },
    });
  }

  return undefined;
}

/** Rung 3: the original abbreviation-then-name heuristic, independent of the pin. */
export function matchAquiferBibleByHeuristic(
  fluentBible: Bible,
  candidates: AquiferBible[]
): AquiferBible | undefined {
  const abbrev = normalizeToken(fluentBible.abbreviation);
  const name = normalizeToken(fluentBible.name);

  const byAbbrev = candidates.find((b) => normalizeToken(b.abbreviation) === abbrev);
  if (byAbbrev) return byAbbrev;

  const byName = candidates.find((b) => normalizeToken(b.name) === name);
  if (byName) return byName;

  return undefined;
}

/**
 * Both providers publish a per-verse WINDOW -- a start and an end -- and both of them are
 * required fields in their respective contracts. Only the start was ever read here, which left
 * `window: [start, end]` consumers with no source for the second number even though it was on
 * the wire. These helpers exist so the two providers converge on one shape as early as
 * possible: after this point nothing downstream knows which provider it came from.
 *
 * The providers disagree on TYPE, and that disagreement is the only provider-specific code
 * left -- Aquifer sends `number` (decimal seconds, verified live), DBL sends `string`.
 */
const START_KEYS = ['startSeconds', 'start', 'seconds', 'time'] as const;
const END_KEYS = ['endSeconds', 'end', 'stop'] as const;

function numericSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function pickSeconds(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const seconds = numericSeconds(record[key]);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

/**
 * Aquifer's `audioTimestamp` is `{ start, end }` in decimal seconds -- confirmed against the
 * live API 2026-08-31, where all 36 verses of a chapter carried one, the last verse included.
 * It is typed `unknown` upstream though, so the keys are still probed defensively and only
 * `number` is accepted, exactly as before; a bare number keeps its old meaning of "a start
 * with no end".
 */
function parseVerseTimestampWindow(value: unknown): {
  startSeconds?: number;
  endSeconds?: number;
} {
  const bare = numericSeconds(value);
  if (bare !== undefined) return { startSeconds: bare };
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    startSeconds: pickSeconds(record, START_KEYS),
    endSeconds: pickSeconds(record, END_KEYS),
  };
}

/**
 * DBL publishes timecodes as STRINGS whose format is undocumented.
 * Seconds-as-decimal matches ABS's own example (`'0.0'` / `'4.5'`) and is
 * what this file already assumed, but `HH:MM:SS.mmm` is not excluded by the contract -- and a
 * bare `Number.parseFloat('01:23.4')` returns `1`, silently, wrong by 83 seconds. Both readings
 * are handled so the DBL path is right under either.
 *
 * This branch is currently unreachable: a sweep of all 355 audio Bibles the configured key can
 * see (2026-08-31) found `timecodes` absent from every one of them. It is written defensively
 * and cannot be proven against live data until a publication ships timing files.
 */
function dblTimecodeToSeconds(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length > 3) return undefined;
    let total = 0;
    for (const part of parts) {
      const unit = Number(part);
      if (!Number.isFinite(unit) || unit < 0) return undefined;
      total = total * 60 + unit;
    }
    return total;
  }

  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function chapterAudioItems(
  chapter: AquiferBibleTextResponse['chapters'][number]
): SourceAudioItem[] {
  const audio = chapter.audio;
  if (!audio) return [];

  const items: SourceAudioItem[] = [];
  const push = (format: 'mp3' | 'webm', file: AquiferMediaFile | null | undefined) => {
    if (!file?.url) return;
    items.push({
      format,
      url: file.url,
      ...(file.size !== null && file.size !== undefined ? { sizeBytes: file.size } : {}),
      scope: 'chapter',
    });
  };

  push('mp3', audio.mp3);
  push('webm', audio.webm);
  return items;
}

function verseTimestampsFromChapter(chapter: AquiferBibleTextResponse['chapters'][number]): {
  timestamps: SourceAudioVerseTimestamp[];
  verseAddressable: boolean;
  missing: number[];
} {
  const timestamps: SourceAudioVerseTimestamp[] = [];
  const missing: number[] = [];
  for (const verse of chapter.verses) {
    const { startSeconds, endSeconds } = parseVerseTimestampWindow(verse.audioTimestamp);
    if (startSeconds === undefined) {
      missing.push(verse.number);
      continue;
    }
    timestamps.push({
      verse: verse.number,
      startSeconds,
      ...(endSeconds !== undefined ? { endSeconds } : {}),
    });
  }
  // The text's own verse list is the extent; do not assume dense USFM numbering.
  // A lone start is sufficient: clients close it at the next start or end-of-file.
  return { timestamps, verseAddressable: timestamps.length > 0 && missing.length === 0, missing };
}

function warnMissingStarts(
  provider: SourceAudioProvider,
  missing: number[],
  context: object
): void {
  logger.warn({
    message: 'Source audio is not verse-addressable: verses are missing a start timestamp',
    context: { provider, missing, ...context },
  });
}

function fileExtFromUrl(url: string, fallback: string): string {
  const clean = url.split('?')[0] ?? url;
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext && /^[a-z0-9]+$/.test(ext) ? ext : fallback;
}

function formatFromUrl(url: string): 'mp3' | 'webm' {
  const ext = fileExtFromUrl(url, 'mp3');
  return ext === 'webm' ? 'webm' : 'mp3';
}

function dblTracksToResponse(params: {
  tracks: BibleAudioResponse[];
  fluentBible: Bible;
  bookCode: UsfmBookCode;
  chapter: number;
  verse?: number;
}): SourceAudioResponse {
  const primary = params.tracks[0]!;
  const verseTimestamps: SourceAudioVerseTimestamp[] = [];
  let verseAddressable = false;
  for (const track of params.tracks) {
    const starts = new Set<number>();
    let maxVerse = 0;
    for (const timecode of track.timecodes ?? []) {
      const versePart = timecode.verseId.split('.').pop();
      const verse = versePart ? Number.parseInt(versePart, 10) : Number.NaN;
      const startSeconds = dblTimecodeToSeconds(timecode.start);
      const endSeconds = dblTimecodeToSeconds(timecode.end);
      if (!Number.isSafeInteger(verse) || verse < 1) continue;
      maxVerse = Math.max(maxVerse, verse);
      if (startSeconds === undefined) continue;
      starts.add(verse);
      verseTimestamps.push({
        verse,
        startSeconds,
        ...(endSeconds !== undefined ? { endSeconds } : {}),
        dblAudioBibleId: track.audioBibleId,
      });
    }
    // DBL has no text verse list: 1..highest verse seen is a weaker extent than Aquifer's.
    // Check each track separately, never the union of different recordings' timestamps.
    if (maxVerse > 0 && starts.size === maxVerse) {
      verseAddressable = true;
    } else if (maxVerse > 0) {
      const missing: number[] = [];
      // Bound diagnostic allocation even if an upstream verse id is corrupt.
      for (let verse = 1; verse <= maxVerse && missing.length < 100; verse++) {
        if (!starts.has(verse)) missing.push(verse);
      }
      warnMissingStarts('dbl', missing, {
        fluentBibleId: params.fluentBible.id,
        bookCode: params.bookCode,
        chapter: params.chapter,
        dblAudioBibleId: track.audioBibleId,
        maxVerse,
      });
    }
  }

  return {
    provider: 'dbl',
    verseAddressable,
    ttsLicenseStatus: params.fluentBible.ttsLicenseStatus,
    licenseNotice: params.fluentBible.licenseNotice,
    bible: {
      name: primary.name,
      abbreviation: params.fluentBible.abbreviation,
      fluentBibleId: params.fluentBible.id,
      dblAudioBibleId: primary.audioBibleId,
    },
    bookCode: params.bookCode,
    chapter: params.chapter,
    ...(params.verse !== undefined ? { verse: params.verse } : {}),
    items: params.tracks.map((track) => ({
      format: formatFromUrl(track.resourceUrl),
      url: track.resourceUrl,
      scope: 'chapter' as const,
      dblAudioBibleId: track.audioBibleId,
      ...(track.expiresAt !== null && track.expiresAt !== undefined
        ? { expiresAt: track.expiresAt }
        : {}),
    })),
    ...(verseTimestamps.length > 0 ? { verseTimestamps } : {}),
  };
}

function emptyAquiferChapterResponse(
  fluentBible: Bible,
  input: ChapterSourceAudioInput
): SourceAudioResponse {
  return {
    provider: 'aquifer',
    verseAddressable: false,
    ttsLicenseStatus: fluentBible.ttsLicenseStatus,
    licenseNotice: fluentBible.licenseNotice,
    bible: {
      name: fluentBible.name,
      abbreviation: fluentBible.abbreviation,
      fluentBibleId: fluentBible.id,
    },
    bookCode: input.bookCode,
    chapter: input.chapter,
    ...(input.verse !== undefined ? { verse: input.verse } : {}),
    items: [],
  };
}

async function getAquiferChapterSourceAudio(
  input: ChapterSourceAudioInput,
  fluentBible: Bible,
  aquiferBible: AquiferBible
): Promise<Result<SourceAudioResponse>> {
  if (aquiferBible.hasAudio === false) {
    return ok(emptyAquiferChapterResponse(fluentBible, input));
  }

  const text = await getBibleText({
    aquiferBibleId: aquiferBible.id,
    bookCode: input.bookCode,
    startChapter: input.chapter,
    endChapter: input.chapter,
    includeAudio: true,
  });
  if (!text.ok) return text;

  const chapter = text.data.chapters.find((entry) => entry.number === input.chapter);
  const items = chapter ? chapterAudioItems(chapter) : [];
  const timing = chapter ? verseTimestampsFromChapter(chapter) : undefined;
  const verseTimestamps = timing?.timestamps ?? [];
  if (items.length > 0 && timing && timing.missing.length > 0) {
    warnMissingStarts('aquifer', timing.missing, {
      fluentBibleId: fluentBible.id,
      aquiferBibleId: aquiferBible.id,
      bookCode: input.bookCode,
      chapter: input.chapter,
    });
  }

  return ok({
    provider: 'aquifer',
    verseAddressable: items.length > 0 && (timing?.verseAddressable ?? false),
    ttsLicenseStatus: fluentBible.ttsLicenseStatus,
    licenseNotice: fluentBible.licenseNotice,
    bible: {
      aquiferBibleId: aquiferBible.id,
      name: text.data.bibleName || aquiferBible.name,
      abbreviation: text.data.bibleAbbreviation || aquiferBible.abbreviation,
      fluentBibleId: fluentBible.id,
    },
    bookCode: input.bookCode,
    chapter: input.chapter,
    ...(input.verse !== undefined ? { verse: input.verse } : {}),
    items,
    ...(verseTimestamps.length > 0 ? { verseTimestamps } : {}),
  });
}

async function getDblChapterSourceAudio(
  input: ChapterSourceAudioInput,
  fluentBible: Bible
): Promise<Result<SourceAudioResponse | null>> {
  const bookResult = await getBookByCode(input.bookCode);
  if (!bookResult.ok) return bookResult;

  const dblResult = await bibleAudioService.getSourceAudio(
    input.fluentBibleId,
    bookResult.data.id,
    input.chapter
  );
  if (!dblResult.ok) return dblResult;
  if (dblResult.data.length === 0) return ok(null);

  return ok(
    dblTracksToResponse({
      tracks: dblResult.data,
      fluentBible,
      bookCode: input.bookCode,
      chapter: input.chapter,
      verse: input.verse,
    })
  );
}

/**
 * Chapter-level source/reference audio: (1) windowed Aquifer pin, (2) windowed DBL link,
 * (3) windowed Aquifer name match, (4) windowless audio, DBL first, (5) empty items (200).
 * Windowed before windowless prevents a future DBL link from displacing BSB's pinned
 * verse-addressable recording. Rung 4 preserves windowless audio in case other consumers
 * still find it valuable; it is explicitly labelled, not mistaken for verse-addressable audio.
 * Each passing rung returns immediately: extra round trips accrue only on the failing path.
 * No cache across requests; timestamp coverage varies by chapter even within one Bible.
 */
export async function getChapterSourceAudio(
  input: ChapterSourceAudioInput
): Promise<Result<SourceAudioResponse>> {
  const fluentBibleResult = await biblesRepo.getById(input.fluentBibleId);
  if (!fluentBibleResult.ok) return fluentBibleResult;
  const fluentBible = fluentBibleResult.data;
  let lastUnavailable: Extract<Result<never>, { ok: false }> | undefined;
  let completedLookup = false;

  // Both providers obey one error policy. Only availability errors advance the ladder.
  function tolerateUnavailable<T>(result: Result<T>): Result<T | null> {
    if (result.ok) return result;
    if (
      result.error.code !== ErrorCode.AQUIFER_SERVICE_UNAVAILABLE &&
      result.error.code !== ErrorCode.DBL_SERVICE_UNAVAILABLE
    ) {
      return result;
    }
    lastUnavailable = result;
    logger.warn({
      cause: result.error,
      message: 'Source audio provider unavailable; trying the next resolver rung',
      context: {
        fluentBibleId: input.fluentBibleId,
        bookCode: input.bookCode,
        chapter: input.chapter,
      },
    });
    return ok(null);
  }

  function recordLookup<T>(result: Result<T>): Result<T | null> {
    if (result.ok) completedLookup = true;
    return tolerateUnavailable(result);
  }

  // Rungs 1 and 3 share even a failed catalogue fetch; no duplicate request or warning.
  let catalogue: Promise<Result<AquiferBible[] | null>> | undefined;
  let pinnedId: number | undefined;
  async function aquiferRung(
    match: typeof matchAquiferBible,
    skipId?: number
  ): Promise<Result<SourceAudioResponse | null>> {
    catalogue ??= getBibles(input.languageCode).then(tolerateUnavailable);
    const candidates = await catalogue;
    if (!candidates.ok) return candidates;
    if (candidates.data === null) return ok(null);
    const bible = match(fluentBible, candidates.data);
    if (!bible) {
      // No heuristic match proves absence only if there was no resolvable pin either.
      // Otherwise this says nothing about a pinned recording whose chapter fetch failed.
      if (match === matchAquiferBibleByHeuristic && pinnedId === undefined) {
        completedLookup = true;
      }
      return ok(null);
    }
    if (bible.id === skipId) return ok(null);
    if (match === matchAquiferBibleByPin) pinnedId = bible.id;
    return recordLookup(await getAquiferChapterSourceAudio(input, fluentBible, bible));
  }

  // Rung 1. A null pin makes no network request.
  const pinned =
    fluentBible.aquiferBibleId != null ? await aquiferRung(matchAquiferBibleByPin) : ok(null);
  if (!pinned.ok) return pinned;
  if (pinned.data?.verseAddressable) return ok(pinned.data);

  // Rung 2. A null link skips even the redundant Bible/book DB lookups.
  const dbl = fluentBible.externalId
    ? recordLookup(await getDblChapterSourceAudio(input, fluentBible))
    : ok(null);
  if (!dbl.ok) return dbl;
  if (dbl.data?.verseAddressable) return ok(dbl.data);

  // Rung 3. Do not fetch the same pinned recording twice, even if it was unavailable.
  const fuzzy = await aquiferRung(matchAquiferBibleByHeuristic, pinnedId);
  if (!fuzzy.ok) return fuzzy;
  if (fuzzy.data?.verseAddressable) return ok(fuzzy.data);

  // Rung 4. Retain partial timing data honestly; never union timings across recordings.
  const windowless = [dbl.data, pinned.data, fuzzy.data].find((audio) => audio?.items.length);
  if (windowless) return ok(windowless);

  // Rung 5. A complete outage is retryable, not an empty result a client may cache as truth.
  if (!completedLookup && lastUnavailable) return lastUnavailable;
  return ok(emptyAquiferChapterResponse(fluentBible, input));
}

/**
 * Prepare Offline Tier 1 source audio manifest for a chapter range (Aquifer-backed).
 */
export async function getSourceAudioManifest(
  input: SourceAudioManifestInput
): Promise<Result<SourceAudioManifestResponse>> {
  const fluentBibleResult = await biblesRepo.getById(input.fluentBibleId);
  if (!fluentBibleResult.ok) return fluentBibleResult;

  const aquiferList = await getBibles(input.languageCode);
  if (!aquiferList.ok) return aquiferList;

  const aquiferBible = matchAquiferBible(fluentBibleResult.data, aquiferList.data);
  if (!aquiferBible || aquiferBible.hasAudio === false) {
    return ok({
      projectId: input.projectId,
      sourceLanguageCode: input.languageCode,
      provider: 'aquifer' satisfies SourceAudioProvider,
      items: [],
      totalBytes: 0,
    });
  }

  const text = await getBibleText({
    aquiferBibleId: aquiferBible.id,
    bookCode: input.bookCode,
    startChapter: input.startChapter,
    endChapter: input.endChapter,
    includeAudio: true,
  });
  if (!text.ok) return text;

  const items: SourceAudioManifestResponse['items'] = [];

  for (const chapter of text.data.chapters) {
    for (const audioItem of chapterAudioItems(chapter)) {
      // Offline manifests require an honest byte budget. Keep unknown-size audio
      // playable online, but do not advertise it as a zero-byte download.
      if (audioItem.sizeBytes === undefined) continue;
      items.push({
        id: `source-audio-${aquiferBible.id}-${input.bookCode}-${chapter.number}-${audioItem.format}`,
        tier: 1,
        kind: 'audio',
        resourceName: 'Source Bible Audio',
        label: `${text.data.bibleAbbreviation} ${input.bookCode} ${chapter.number} (${audioItem.format})`,
        required: true,
        removable: false,
        bytesTotal: audioItem.sizeBytes,
        sourceUrl: audioItem.url,
        fileExt: fileExtFromUrl(audioItem.url, audioItem.format),
        languageCode: input.languageCode,
        bookCode: input.bookCode,
        startChapter: chapter.number,
        endChapter: chapter.number,
        format: audioItem.format,
        aquiferBibleId: aquiferBible.id,
      });
    }
  }

  return ok({
    projectId: input.projectId,
    sourceLanguageCode: input.languageCode,
    provider: 'aquifer' satisfies SourceAudioProvider,
    items,
    totalBytes: items.reduce((sum, item) => sum + item.bytesTotal, 0),
  });
}
