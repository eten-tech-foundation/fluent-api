import type { ProviderIdentity } from '@/domains/bible-provider-resources/bible-provider-resources.types';
import type { BibleAudioResponse } from '@/domains/bibles/bible-audio/bible-audio.types';
import type { UsfmBookCode } from '@/domains/translation-resources/translation-resources.types';
import type { Result } from '@/lib/types';

import { bibleKey } from '@/domains/bible-provider-resources/bible-provider-resources.identity';
import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { getBibleRecordById } from '@/domains/bibles/bibles.service';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import type { PlaybackAudioResponse } from './playback-audio.types';

import { getSourceChapterVerseNumbers } from './playback-audio.repository';

interface ChapterInput {
  languageCode: string;
  bookCode: UsfmBookCode;
  chapter: number;
  verse?: number;
}

export async function getResourceFacts(identity: ProviderIdentity) {
  const record = await resources.getByProviderIdentity(identity.provider, identity.externalId);
  if (!record.ok) return record;
  return ok({
    ...identity,
    bibleKey: bibleKey(identity),
    id: record.data?.id ?? null,
    ttsLicenseStatus: record.data?.ttsLicenseStatus ?? 'unknown',
    licenseNotice: record.data?.licenseNotice ?? null,
  });
}

function empty(input: ChapterInput, identity: ProviderIdentity | null): PlaybackAudioResponse {
  return {
    provider: identity?.provider ?? 'dbl',
    bible: { name: '', abbreviation: '' },
    bookCode: input.bookCode,
    chapter: input.chapter,
    ...(input.verse === undefined ? {} : { verse: input.verse }),
    textBibleKey: null,
    selectedRecordingKey: null,
    ttsLicenseStatus: 'unknown',
    verseAddressable: false,
    items: [],
  };
}

export async function getSourcePlayback(
  input: ChapterInput & { fluentBibleId: number }
): Promise<Result<PlaybackAudioResponse>> {
  const source = await getBibleRecordById(input.fluentBibleId);
  if (!source.ok) return source;
  const text = source.data.externalId
    ? { provider: source.data.provider, externalId: source.data.externalId }
    : null;
  const selected =
    source.data.audioResourceId === null
      ? ok(null)
      : await resources.getById(source.data.audioResourceId);
  if (!selected.ok) return selected;
  // A missing selected FK is corruption, not permission to change providers.
  if (source.data.audioResourceId !== null && !selected.data) return err(ErrorCode.INTERNAL_ERROR);
  const result = await resolve(input, text, selected.data, source.data.id);
  if (result.ok) result.data.bible.fluentBibleId = source.data.id;
  return result;
}

export function getReferencePlayback(input: ChapterInput & { identity: ProviderIdentity }) {
  // DBL is intentionally best effort here. The current reference picker does
  // not expose DBL choices, and the measured live catalogue had no timecodes,
  // so this path is contract-tested without claiming live reference coverage.
  return resolve(input, input.identity, null);
}

async function resolve(
  input: ChapterInput,
  text: ProviderIdentity | null,
  selected: ProviderIdentity | null,
  sourceBibleId?: number
): Promise<Result<PlaybackAudioResponse>> {
  // Read text policy independently; media never confers permission.
  const facts = text ? await getResourceFacts(text) : ok(null);
  if (!facts.ok) return facts;
  const recording = selected ?? text;
  let result: Result<PlaybackAudioResponse> = ok(empty(input, recording));
  if (recording?.provider === 'aquifer') result = await aquifer(input, recording, sourceBibleId);
  if (recording?.provider === 'dbl') result = await dbl(input, recording, selected, sourceBibleId);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    textBibleKey: text ? bibleKey(text) : null,
    selectedRecordingKey: selected ? bibleKey(selected) : null,
    ttsLicenseStatus: facts.data?.ttsLicenseStatus ?? 'unknown',
  });
}

function parseNonNegativeSeconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseAquiferTimestamp(value: unknown): { startSeconds?: number; endSeconds?: number } {
  if (typeof value === 'number') return { startSeconds: parseNonNegativeSeconds(value) };
  if (!value || typeof value !== 'object') return {};
  const row = value as Record<string, unknown>;
  const startSeconds = ['startSeconds', 'start', 'seconds', 'time']
    .map((key) => parseNonNegativeSeconds(row[key]))
    .find((n) => n !== undefined);
  const endSeconds = ['endSeconds', 'end', 'stop']
    .map((key) => parseNonNegativeSeconds(row[key]))
    .find((n) => n !== undefined);
  return {
    startSeconds,
    endSeconds:
      endSeconds !== undefined && startSeconds !== undefined && endSeconds > startSeconds
        ? endSeconds
        : undefined,
  };
}

async function aquifer(
  input: ChapterInput,
  identity: ProviderIdentity,
  sourceBibleId?: number
): Promise<Result<PlaybackAudioResponse>> {
  const catalogue = await getBibles(input.languageCode);
  if (!catalogue.ok) return catalogue;
  const entry = catalogue.data.find((candidate) => String(candidate.id) === identity.externalId);
  if (!entry) return err(ErrorCode.BIBLE_NOT_FOUND);
  const base = empty(input, identity);
  base.bible = { aquiferBibleId: entry.id, name: entry.name, abbreviation: entry.abbreviation };
  if (entry.hasAudio === false) return ok(base);
  const response = await getBibleText({
    aquiferBibleId: entry.id,
    bookCode: input.bookCode,
    startChapter: input.chapter,
    endChapter: input.chapter,
    includeAudio: true,
  });
  if (!response.ok) return response;
  const chapter = response.data.chapters.find((candidate) => candidate.number === input.chapter);
  if (!chapter) return ok(base);
  const facts = await getResourceFacts(identity);
  if (!facts.ok) return facts;
  for (const format of ['mp3', 'webm'] as const) {
    const file = chapter.audio?.[format];
    if (file?.url)
      base.items.push({
        format,
        url: file.url,
        scope: 'chapter',
        recordingKey: bibleKey(identity),
        licenseNotice: facts.data.licenseNotice,
        ...(file.size == null ? {} : { sizeBytes: file.size }),
      });
  }
  base.verseTimestamps = chapter.verses.flatMap((verse) => {
    const window = parseAquiferTimestamp(verse.audioTimestamp);
    return window.startSeconds === undefined
      ? []
      : [
          {
            verse: verse.number,
            startSeconds: window.startSeconds,
            ...(window.endSeconds === undefined ? {} : { endSeconds: window.endSeconds }),
          },
        ];
  });
  if (base.items.length > 0 && base.verseTimestamps.length > 0) {
    const expected =
      sourceBibleId === undefined
        ? ok(chapter.verses.map((verse) => verse.number))
        : await getSourceChapterVerseNumbers(sourceBibleId, input.bookCode, input.chapter);
    if (!expected.ok) return expected;
    base.verseAddressable = hasExactVerseCoverage(
      new Set(base.verseTimestamps.map((entry) => entry.verse)),
      expected.data
    );
  }
  return ok(base);
}

export function parseDblTimestampSeconds(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value) && !/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(value))
    return undefined;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return undefined;
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number.isFinite(total) ? total : undefined;
}

function parseDblVerseNumber(verseId: string, chapterPrefix: string): number | undefined {
  if (!verseId.startsWith(chapterPrefix)) return undefined;
  const suffix = verseId.slice(chapterPrefix.length);
  if (!/^[1-9]\d*$/.test(suffix)) return undefined;
  const verse = Number(suffix);
  return Number.isSafeInteger(verse) ? verse : undefined;
}

async function dbl(
  input: ChapterInput,
  identity: ProviderIdentity,
  selectedRecording: ProviderIdentity | null,
  sourceBibleId?: number
): Promise<Result<PlaybackAudioResponse>> {
  const base = empty(input, identity);
  let audioIds: { id: string; name?: string }[] = [{ id: identity.externalId }];
  if (selectedRecording === null) {
    const textBible = await dblClient.getBible(identity.externalId);
    if (!textBible.ok) return textBible;
    audioIds = textBible.data.audioBibles ?? [];
    base.bible = { name: textBible.data.name, abbreviation: textBible.data.abbreviation };
  }
  const timestamps: NonNullable<PlaybackAudioResponse['verseTimestamps']> = [];
  const trackWindows: { starts: Set<number> }[] = [];
  const chapterPrefix = `${input.bookCode}.${input.chapter}.`;
  for (const audio of audioIds) {
    const chapter = await dblClient.getAudioChapter(audio.id, `${input.bookCode}.${input.chapter}`);
    if (!chapter.ok) {
      if (chapter.error.code === ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND) continue;
      return chapter;
    }
    const recording = { provider: 'dbl' as const, externalId: audio.id };
    const notice = await getResourceFacts(recording);
    if (!notice.ok) return notice;
    const track: BibleAudioResponse = {
      audioBibleId: audio.id,
      name: audio.name ?? '',
      chapterId: chapter.data.id,
      resourceUrl: chapter.data.resourceUrl,
      expiresAt: chapter.data.expiresAt,
      timecodes: chapter.data.timecodes,
    };
    base.items.push({
      format: track.resourceUrl.split('?')[0]?.endsWith('.webm') ? 'webm' : 'mp3',
      url: track.resourceUrl,
      scope: 'chapter',
      dblAudioBibleId: audio.id,
      recordingKey: bibleKey(recording),
      trackId: track.chapterId,
      licenseNotice: notice.data.licenseNotice,
      ...(track.expiresAt == null ? {} : { expiresAt: track.expiresAt }),
    });
    const starts = new Set<number>();
    for (const code of track.timecodes ?? []) {
      const verse = parseDblVerseNumber(code.verseId, chapterPrefix);
      if (verse === undefined) continue;
      const start = parseDblTimestampSeconds(code.start);
      const end = parseDblTimestampSeconds(code.end);
      if (start === undefined) continue;
      starts.add(verse);
      timestamps.push({
        verse,
        startSeconds: start,
        ...(end !== undefined && end > start ? { endSeconds: end } : {}),
        dblAudioBibleId: audio.id,
      });
    }
    trackWindows.push({ starts });
  }
  if (timestamps.length) base.verseTimestamps = timestamps;
  if (timestamps.length) {
    // Source chapters use the local text being drafted; references use the DBL
    // text Bible's verse list. Never infer chapter length from audio timecodes.
    let expectedVerses: number[];
    if (sourceBibleId === undefined) {
      const expected = await dblClient.getVerses(
        identity.externalId,
        `${input.bookCode}.${input.chapter}`
      );
      // A failed lookup is not evidence that the text has zero verses.
      if (!expected.ok) return expected;
      expectedVerses = expected.data.map(
        (verse) => parseDblVerseNumber(verse.id, chapterPrefix) ?? 0
      );
    } else {
      const expected = await getSourceChapterVerseNumbers(
        sourceBibleId,
        input.bookCode,
        input.chapter
      );
      // Local database failures must not invite an unsafe TTS fallback either.
      if (!expected.ok) return expected;
      expectedVerses = expected.data;
    }
    // The browser chooses the sole timecoded track when there is one, or the
    // first track otherwise. Judge that same track, never the merged timestamps.
    const timecoded = trackWindows.filter((window) => window.starts.size > 0);
    const chosen = timecoded.length === 1 ? timecoded[0] : trackWindows[0];
    base.verseAddressable =
      chosen !== undefined && hasExactVerseCoverage(chosen.starts, expectedVerses);
  }
  return ok(base);
}

function hasExactVerseCoverage(actual: Set<number>, expectedVerseNumbers: number[]): boolean {
  if (expectedVerseNumbers.length === 0) return false;
  const expected = new Set(expectedVerseNumbers);
  return (
    expected.size === expectedVerseNumbers.length &&
    actual.size === expected.size &&
    expectedVerseNumbers.every((verse) => actual.has(verse))
  );
}
