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
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  return Number.isFinite(parsed) ? parsed : undefined;
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

function verseTimestampsFromChapter(
  chapter: AquiferBibleTextResponse['chapters'][number]
): SourceAudioVerseTimestamp[] {
  const timestamps: SourceAudioVerseTimestamp[] = [];
  for (const verse of chapter.verses) {
    const { startSeconds, endSeconds } = parseVerseTimestampWindow(verse.audioTimestamp);
    if (startSeconds === undefined) continue;
    timestamps.push({
      verse: verse.number,
      startSeconds,
      ...(endSeconds !== undefined ? { endSeconds } : {}),
    });
  }
  return timestamps;
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
  for (const track of params.tracks) {
    for (const timecode of track.timecodes ?? []) {
      const versePart = timecode.verseId.split('.').pop();
      const verse = versePart ? Number.parseInt(versePart, 10) : Number.NaN;
      const startSeconds = dblTimecodeToSeconds(timecode.start);
      const endSeconds = dblTimecodeToSeconds(timecode.end);
      if (!Number.isFinite(verse) || startSeconds === undefined) continue;
      verseTimestamps.push({
        verse,
        startSeconds,
        ...(endSeconds !== undefined ? { endSeconds } : {}),
        dblAudioBibleId: track.audioBibleId,
      });
    }
  }

  return {
    provider: 'dbl',
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
  fluentBible: Bible
): Promise<Result<SourceAudioResponse>> {
  const aquiferList = await getBibles(input.languageCode);
  if (!aquiferList.ok) return aquiferList;

  const aquiferBible = matchAquiferBible(fluentBible, aquiferList.data);
  if (!aquiferBible || aquiferBible.hasAudio === false) {
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
  const verseTimestamps = chapter ? verseTimestampsFromChapter(chapter) : [];

  return ok({
    provider: 'aquifer',
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
 * Chapter-level source/reference audio for drafting. Prefers DBL when the Fluent
 * bible is linked; falls back to Aquifer when DBL has no tracks or DBL is down.
 * Empty `items` when neither has audio (including unmatched Aquifer catalogues).
 */
export async function getChapterSourceAudio(
  input: ChapterSourceAudioInput
): Promise<Result<SourceAudioResponse>> {
  const fluentBibleResult = await biblesRepo.getById(input.fluentBibleId);
  if (!fluentBibleResult.ok) return fluentBibleResult;

  const dblResult = await getDblChapterSourceAudio(input, fluentBibleResult.data);
  if (dblResult.ok) {
    if (dblResult.data) return ok(dblResult.data);
  } else if (dblResult.error.code !== ErrorCode.DBL_SERVICE_UNAVAILABLE) {
    return dblResult;
  } else {
    logger.warn({
      cause: dblResult.error,
      message: 'DBL source audio unavailable; trying Aquifer',
      context: {
        fluentBibleId: input.fluentBibleId,
        bookCode: input.bookCode,
        chapter: input.chapter,
      },
    });
  }

  return getAquiferChapterSourceAudio(input, fluentBibleResult.data);
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
