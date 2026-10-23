import type { Result } from '@/lib/types';

import { audioBlobName, generateAudioDownloadUrl } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  VerseAudioRecord,
  VerseAudioTakeRecord,
  VerseAudioTakeWithUrl,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';

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
  entries: Array<{ record: VerseAudioRecord; takes: VerseAudioTakeRecord[] }>
): number[] {
  const ids = new Set<number>();
  for (const { record, takes } of entries) {
    for (const take of takes) {
      if (isLegacyContentHash(take.contentHash) && take.storageObjectId !== null) {
        ids.add(take.storageObjectId);
      }
    }

    const active = takes.find((t) => t.id === record.activeTakeId) ?? takes[takes.length - 1];
    const activeIsLegacy = active ? isLegacyContentHash(active.contentHash) : true;
    if (activeIsLegacy && record.storageObjectId !== null) {
      ids.add(record.storageObjectId);
    }
  }
  return [...ids];
}

async function takeWithUrl(
  take: VerseAudioTakeRecord,
  projectUnitId: number,
  bibleTextId: number,
  keysById: Map<number, string>
): Promise<VerseAudioTakeWithUrl> {
  return {
    id: take.id,
    uploadedBy: take.uploadedBy,
    contentType: take.contentType,
    sizeBytes: take.sizeBytes,
    durationSeconds: take.durationSeconds,
    contentHash: take.contentHash,
    granularity: take.granularity,
    startChapter: take.startChapter,
    startVerse: take.startVerse,
    endChapter: take.endChapter,
    endVerse: take.endVerse,
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
    takes.map((take) => takeWithUrl(take, record.projectUnitId, record.bibleTextId, keysById))
  );

  const active =
    takeViews.find((t) => t.id === record.activeTakeId) ?? takeViews[takeViews.length - 1];

  const activeHash = active?.contentHash ?? `${LEGACY_CONTENT_HASH_PREFIX}missing`;

  return {
    id: record.id,
    projectUnitId: record.projectUnitId,
    bibleTextId: record.bibleTextId,
    uploadedBy: record.uploadedBy,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    durationSeconds: record.durationSeconds,
    versionToken: record.versionToken,
    conflictStatus: record.conflictStatus,
    granularity: record.granularity,
    startChapter: record.startChapter,
    startVerse: record.startVerse,
    endChapter: record.endChapter,
    endVerse: record.endVerse,
    activeTakeId: record.activeTakeId,
    verseNumber: record.verseNumber,
    downloadUrl: await resolveDownloadUrl(
      record.storageObjectId,
      activeHash,
      record.projectUnitId,
      record.bibleTextId,
      keysById
    ),
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
