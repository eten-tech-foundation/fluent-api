import type { ProviderIdentity } from '@/domains/bible-provider-resources/identity';
import type { BibleAudioResponse } from '@/domains/bibles/bible-audio/bible-audio.types';
import type { UsfmBookCode } from '@/domains/translation-resources/translation-resources.types';
import type { Result } from '@/lib/types';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.repository';
import { bibleKey } from '@/domains/bible-provider-resources/identity';
import * as bibles from '@/domains/bibles/bibles.repository';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import type { PlaybackAudioResponse } from './playback-audio.types';

import { getSourceChapterVerseCount } from './playback-audio.repository';

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
  const source = await bibles.getById(input.fluentBibleId);
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
  const result = await resolve(input, text, selected.data, selected.data !== null, source.data.id);
  if (result.ok) result.data.bible.fluentBibleId = source.data.id;
  return result;
}

export function getReferencePlayback(input: ChapterInput & { identity: ProviderIdentity }) {
  return resolve(input, input.identity, null, false);
}

async function resolve(
  input: ChapterInput,
  text: ProviderIdentity | null,
  selected: ProviderIdentity | null,
  directAudio: boolean,
  sourceBibleId?: number
): Promise<Result<PlaybackAudioResponse>> {
  // Read text policy independently; media never confers permission.
  const facts = text ? await getResourceFacts(text) : ok(null);
  if (!facts.ok) return facts;
  const recording = selected ?? text;
  let result: Result<PlaybackAudioResponse> = ok(empty(input, recording));
  if (recording?.provider === 'aquifer') result = await aquifer(input, recording);
  if (recording?.provider === 'dbl')
    result = await dbl(input, recording, directAudio, sourceBibleId);
  if (!result.ok) return result;
  return ok({
    ...result.data,
    textBibleKey: text ? bibleKey(text) : null,
    selectedRecordingKey: selected ? bibleKey(selected) : null,
    ttsLicenseStatus: facts.data?.ttsLicenseStatus ?? 'unknown',
  });
}

function seconds(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function timestamp(value: unknown): { startSeconds?: number; endSeconds?: number } {
  if (typeof value === 'number') return { startSeconds: seconds(value) };
  if (!value || typeof value !== 'object') return {};
  const row = value as Record<string, unknown>;
  const startSeconds = ['startSeconds', 'start', 'seconds', 'time']
    .map((key) => seconds(row[key]))
    .find((n) => n !== undefined);
  const endSeconds = ['endSeconds', 'end', 'stop']
    .map((key) => seconds(row[key]))
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
  identity: ProviderIdentity
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
    const window = timestamp(verse.audioTimestamp);
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
  base.verseAddressable =
    base.items.length > 0 &&
    chapter.verses.length > 0 &&
    base.verseTimestamps.length === chapter.verses.length;
  return ok(base);
}

export function dblSeconds(value: string): number | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value) && !/^\d+(?::\d{1,2}){1,2}(?:\.\d+)?$/.test(value))
    return undefined;
  const parts = value.split(':').map(Number);
  if (parts.slice(1).some((part) => part >= 60)) return undefined;
  const total = parts.reduce((sum, part) => sum * 60 + part, 0);
  return Number.isFinite(total) ? total : undefined;
}

async function dbl(
  input: ChapterInput,
  identity: ProviderIdentity,
  directAudio: boolean,
  sourceBibleId?: number
): Promise<Result<PlaybackAudioResponse>> {
  const base = empty(input, identity);
  let audioIds: { id: string; name?: string }[] = [{ id: identity.externalId }];
  if (!directAudio) {
    const textBible = await dblClient.getBible(identity.externalId);
    if (!textBible.ok) return textBible;
    audioIds = textBible.data.audioBibles ?? [];
    base.bible = { name: textBible.data.name, abbreviation: textBible.data.abbreviation };
  }
  const timestamps: NonNullable<PlaybackAudioResponse['verseTimestamps']> = [];
  const trackWindows: { starts: Set<number>; maximum: number }[] = [];
  for (const audio of audioIds) {
    const chapter = await dblClient.getAudioChapter(audio.id, `${input.bookCode}.${input.chapter}`);
    if (!chapter.ok) {
      if (chapter.error.message.includes('404')) continue;
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
    let maximum = 0;
    for (const code of track.timecodes ?? []) {
      const prefix = `${input.bookCode}.${input.chapter}.`;
      if (!code.verseId.startsWith(prefix)) continue;
      const suffix = code.verseId.slice(prefix.length);
      if (!/^[1-9]\d*$/.test(suffix)) continue;
      const verse = Number(suffix);
      if (!Number.isSafeInteger(verse)) continue;
      maximum = Math.max(maximum, verse);
      const start = dblSeconds(code.start);
      const end = dblSeconds(code.end);
      if (start === undefined) continue;
      starts.add(verse);
      timestamps.push({
        verse,
        startSeconds: start,
        ...(end !== undefined && end > start ? { endSeconds: end } : {}),
        dblAudioBibleId: audio.id,
      });
    }
    trackWindows.push({ starts, maximum });
  }
  if (timestamps.length) base.verseTimestamps = timestamps;
  if (timestamps.length) {
    // Source chapters use the local text being drafted; references use the DBL
    // text Bible's verse list. Never infer chapter length from audio timecodes.
    const expected =
      sourceBibleId === undefined
        ? await dblClient.getVerses(identity.externalId, `${input.bookCode}.${input.chapter}`)
        : await getSourceChapterVerseCount(sourceBibleId, input.bookCode, input.chapter);
    // If the text count is unavailable, keep the chapter recording but leave
    // verse addressing disabled; unknown length cannot establish completeness.
    if (expected.ok) {
      const expectedVerses = Array.isArray(expected.data) ? expected.data.length : expected.data;
      // The browser chooses the sole timecoded track when there is one, or the
      // first track otherwise. Judge that same track, never the merged timestamps.
      const timecoded = trackWindows.filter((window) => window.starts.size > 0);
      const chosen = timecoded.length === 1 ? timecoded[0] : trackWindows[0];
      base.verseAddressable =
        expectedVerses > 0 &&
        chosen?.starts.size === expectedVerses &&
        chosen.maximum === expectedVerses;
    }
  }
  return ok(base);
}
