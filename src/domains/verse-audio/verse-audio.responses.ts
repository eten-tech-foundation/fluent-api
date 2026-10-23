import type { Result } from '@/lib/types';

import { audioBlobName, generateAudioDownloadUrl } from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  VerseAudioCoverageShape,
  VerseAudioRecord,
  VerseAudioTakeRecord,
  VerseAudioTakeWithUrl,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import { shapeFields, shapeFromRecord, shapeFromTake } from './verse-audio.shapes';
import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

/** Migration 0025 placeholders — real bytes live at the pre-hash key shape. */
const LEGACY_CONTENT_HASH_PREFIX = 'legacy-';

function toIso(date: Date): string {
  return date.toISOString();
}

function isLegacyContentHash(contentHash: string): boolean {
  return contentHash.startsWith(LEGACY_CONTENT_HASH_PREFIX);
}

/** Pre-hash object key (`unit-{id}/text-{id}`) used before contentHash entered the path. */
function legacyBlobName(projectUnitId: number, bibleTextId: number): string {
  return `unit-${projectUnitId}/text-${bibleTextId}`;
}

export function fallbackBlobKey(
  projectUnitId: number,
  bibleTextId: number,
  contentHash: string
): string {
  return isLegacyContentHash(contentHash)
    ? legacyBlobName(projectUnitId, bibleTextId)
    : audioBlobName(projectUnitId, bibleTextId, contentHash);
}

/**
 * Wire coverage for selected-canonical clients. Verse units persist null range
 * columns; hydration fills inclusive anchors from bible_texts. Pericope uses
 * stored bounds unchanged (including anomalous all-null bounds — pass-through).
 *
 * Deliberately diverges from `coverageFromActive` (conflict geometry): that
 * helper anchor-fills when pericope bounds are null so overlap scans stay
 * well-defined. Wire hydration must not invent pericope spans; writes validate
 * bounds, so null pericope coverage is only reachable via anomalous data.
 */
export function hydrateCoverageForWire(
  shape: VerseAudioCoverageShape,
  anchorChapter: number,
  anchorVerse: number
): VerseAudioCoverageShape {
  if (shape.granularity === VERSE_AUDIO_GRANULARITY.VERSE) {
    return {
      granularity: VERSE_AUDIO_GRANULARITY.VERSE,
      startChapter: anchorChapter,
      startVerse: anchorVerse,
      endChapter: anchorChapter,
      endVerse: anchorVerse,
    };
  }
  return shapeFields(shape);
}

async function storageKeysById(ids: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (ids.length === 0) {
    return map;
  }

  const result = await storageRepo.getByIds(ids);
  if (!result.ok) {
    return map;
  }
  for (const row of result.data) {
    map.set(row.id, row.key);
  }
  return map;
}

/**
 * Modern takes use a deterministic hash-keyed blob name — no DB round trip.
 * Legacy backfill rows still need storage_objects.key (old path without hash).
 */
function resolveDownloadUrl(
  storageObjectId: number | null,
  contentHash: string,
  projectUnitId: number,
  bibleTextId: number,
  keysById: Map<number, string>
): Promise<string> {
  if (isLegacyContentHash(contentHash) && storageObjectId !== null) {
    const key = keysById.get(storageObjectId);
    if (key) {
      return generateAudioDownloadUrl(key);
    }
  }
  return generateAudioDownloadUrl(fallbackBlobKey(projectUnitId, bibleTextId, contentHash));
}

function collectLegacyStorageObjectIds(
  entries: Array<{ takes: VerseAudioTakeRecord[] }>
): number[] {
  const ids = new Set<number>();
  for (const { takes } of entries) {
    for (const take of takes) {
      if (isLegacyContentHash(take.contentHash) && take.storageObjectId !== null) {
        ids.add(take.storageObjectId);
      }
    }
  }
  return [...ids];
}

async function takeWithUrl(
  take: VerseAudioTakeRecord,
  projectUnitId: number,
  bibleTextId: number,
  anchorChapter: number,
  anchorVerse: number,
  keysById: Map<number, string>
): Promise<VerseAudioTakeWithUrl> {
  const coverage = hydrateCoverageForWire(shapeFromTake(take), anchorChapter, anchorVerse);
  return {
    id: take.id,
    uploadedBy: take.uploadedBy,
    contentType: take.contentType,
    sizeBytes: take.sizeBytes,
    durationSeconds: take.durationSeconds,
    contentHash: take.contentHash,
    ...coverage,
    downloadUrl: await resolveDownloadUrl(
      take.storageObjectId,
      take.contentHash,
      projectUnitId,
      bibleTextId,
      keysById
    ),
    createdAt: toIso(take.createdAt),
    updatedAt: toIso(take.updatedAt),
  };
}

async function withTakesAndUrl(
  record: VerseAudioRecord,
  takes: VerseAudioTakeRecord[],
  keysById: Map<number, string>
): Promise<VerseAudioWithUrl> {
  const takeViews = await Promise.all(
    takes.map((take) =>
      takeWithUrl(
        take,
        record.projectUnitId,
        record.bibleTextId,
        record.chapterNumber,
        record.verseNumber,
        keysById
      )
    )
  );

  const activeTake = takes.find((t) => t.id === record.activeTakeId);
  const activeView = activeTake ? takeViews.find((t) => t.id === activeTake.id) : undefined;

  if (record.activeTakeId != null && !activeTake) {
    logger.warn({
      message: 'Verse audio activeTakeId has no matching take; top-level download unavailable',
      context: {
        recordingId: record.id,
        projectUnitId: record.projectUnitId,
        bibleTextId: record.bibleTextId,
        activeTakeId: record.activeTakeId,
        takeIds: takes.map((t) => t.id),
      },
    });
  }

  // Selected-canonical: coverage + URL from exact active match only.
  const coverage = hydrateCoverageForWire(
    activeTake ? shapeFromTake(activeTake) : shapeFromRecord(record),
    record.chapterNumber,
    record.verseNumber
  );

  const downloadUrl = activeView?.downloadUrl ?? null;

  // Blob metadata: prefer the matched active take so top-level fields cannot
  // disagree with takes[]. When unmatched/null active, fall back to the
  // denormalized recording row (CAS writes keep it mirrored to active).
  const uploadedBy = activeView?.uploadedBy ?? record.uploadedBy;
  const contentType = activeView?.contentType ?? record.contentType;
  const sizeBytes = activeView?.sizeBytes ?? record.sizeBytes;
  const durationSeconds = activeView?.durationSeconds ?? record.durationSeconds;

  return {
    id: record.id,
    projectUnitId: record.projectUnitId,
    bibleTextId: record.bibleTextId,
    uploadedBy,
    contentType,
    sizeBytes,
    durationSeconds,
    versionToken: record.versionToken,
    conflictStatus: record.conflictStatus,
    ...coverage,
    activeTakeId: record.activeTakeId,
    verseNumber: record.verseNumber,
    downloadUrl,
    takes: takeViews,
    createdAt: toIso(record.createdAt),
    updatedAt: toIso(record.updatedAt),
  };
}

export async function buildRecordingResponses(
  entries: Array<{ record: VerseAudioRecord; takes: VerseAudioTakeRecord[] }>
): Promise<VerseAudioWithUrl[]> {
  const keysById = await storageKeysById(collectLegacyStorageObjectIds(entries));
  return Promise.all(entries.map(({ record, takes }) => withTakesAndUrl(record, takes, keysById)));
}

export async function loadUnitResponse(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  const recording = await repo.get(projectUnitId, bibleTextId);
  if (!recording.ok) {
    return recording;
  }

  const takes = await takesRepo.listTakesForRecording(recording.data.id);
  if (!takes.ok) {
    return takes;
  }

  const [response] = await buildRecordingResponses([{ record: recording.data, takes: takes.data }]);
  if (!response) {
    return err(ErrorCode.INTERNAL_ERROR);
  }
  return ok(response);
}
