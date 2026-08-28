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

export function matchAquiferBible(
  fluentBible: Bible,
  candidates: AquiferBible[]
): AquiferBible | undefined {
  if (candidates.length === 0) return undefined;

  const abbrev = normalizeToken(fluentBible.abbreviation);
  const name = normalizeToken(fluentBible.name);

  const byAbbrev = candidates.find((b) => normalizeToken(b.abbreviation) === abbrev);
  if (byAbbrev) return byAbbrev;

  const byName = candidates.find((b) => normalizeToken(b.name) === name);
  if (byName) return byName;

  return undefined;
}

function parseVerseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ['startSeconds', 'start', 'seconds', 'time']) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
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
      sizeBytes: file.size,
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
    const startSeconds = parseVerseTimestamp(verse.audioTimestamp);
    if (startSeconds === undefined) continue;
    timestamps.push({ verse: verse.number, startSeconds });
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
  fluentBibleId: number;
  bookCode: UsfmBookCode;
  chapter: number;
  verse?: number;
}): SourceAudioResponse {
  const primary = params.tracks[0]!;
  const verseTimestamps: SourceAudioVerseTimestamp[] = [];
  for (const timecode of primary.timecodes ?? []) {
    const versePart = timecode.verseId.split('.').pop();
    const verse = versePart ? Number.parseInt(versePart, 10) : Number.NaN;
    const startSeconds = Number.parseFloat(timecode.start);
    if (!Number.isFinite(verse) || !Number.isFinite(startSeconds)) continue;
    verseTimestamps.push({ verse, startSeconds });
  }

  return {
    provider: 'dbl',
    bible: {
      name: primary.name,
      abbreviation: primary.name,
      fluentBibleId: params.fluentBibleId,
      dblAudioBibleId: primary.audioBibleId,
    },
    bookCode: params.bookCode,
    chapter: params.chapter,
    ...(params.verse !== undefined ? { verse: params.verse } : {}),
    items: params.tracks.map((track) => ({
      format: formatFromUrl(track.resourceUrl),
      url: track.resourceUrl,
      sizeBytes: 0,
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
  if (!aquiferBible) {
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
  fluentBibleId: number
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
      fluentBibleId,
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

  const dblResult = await getDblChapterSourceAudio(input, fluentBibleResult.data.id);
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
  if (!aquiferBible) {
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
