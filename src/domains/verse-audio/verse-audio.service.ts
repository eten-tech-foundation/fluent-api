import type { Buffer } from 'node:buffer';

import { createHash } from 'node:crypto';

import type { Result } from '@/lib/types';

import env from '@/env';
import {
  audioBlobName,
  audioBucket,
  deleteVerseAudio,
  generateAudioDownloadUrl,
  uploadVerseAudio,
} from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  ResolveConflictInput,
  UploadRecordingInput,
  VerseAudioRecord,
  VerseAudioTakeRecord,
  VerseAudioTakeWithUrl,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as repo from './verse-audio.repository';
import { ALLOWED_AUDIO_CONTENT_TYPES, VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

/** Migration 0025 placeholders — real bytes live at the pre-hash key shape. */
const LEGACY_CONTENT_HASH_PREFIX = 'legacy-';

function contentHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

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

function fallbackBlobKey(projectUnitId: number, bibleTextId: number, contentHash: string): string {
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

async function buildRecordingResponses(
  entries: Array<{ record: VerseAudioRecord; takes: VerseAudioTakeRecord[] }>
): Promise<VerseAudioWithUrl[]> {
  const keysById = await storageKeysById(collectLegacyStorageObjectIds(entries));
  return Promise.all(entries.map(({ record, takes }) => withTakesAndUrl(record, takes, keysById)));
}

async function loadUnitResponse(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  const recording = await repo.get(projectUnitId, bibleTextId);
  if (!recording.ok) {
    return recording;
  }

  const takes = await repo.listTakesForRecording(recording.data.id);
  if (!takes.ok) {
    return takes;
  }

  const [response] = await buildRecordingResponses([{ record: recording.data, takes: takes.data }]);
  if (!response) {
    return err(ErrorCode.INTERNAL_ERROR);
  }
  return ok(response);
}

async function storeTakeBytes(
  projectUnitId: number,
  bibleTextId: number,
  contentHash: string,
  data: Buffer,
  contentType: string
): Promise<Result<{ storageObjectId: number; key: string }>> {
  const key = audioBlobName(projectUnitId, bibleTextId, contentHash);
  const claim = await storageRepo.claim(audioBucket(), key);
  if (!claim.ok) {
    return claim;
  }

  try {
    await uploadVerseAudio(key, data, contentType);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upload verse audio object',
      context: { key, contentType, sizeBytes: data.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }

  return ok({ storageObjectId: claim.data.id, key });
}

export async function uploadRecording(
  input: UploadRecordingInput
): Promise<Result<VerseAudioWithUrl>> {
  if (!ALLOWED_AUDIO_CONTENT_TYPES.has(input.contentType)) {
    return err(ErrorCode.UNSUPPORTED_AUDIO_TYPE);
  }
  if (input.data.length === 0) {
    return err(ErrorCode.EMPTY_AUDIO_FILE);
  }

  const contentHash = contentHashOf(input.data);
  const durationSeconds = input.durationSeconds ?? null;
  const existing = await repo.get(input.projectUnitId, input.bibleTextId);

  if (!existing.ok && existing.error.code !== ErrorCode.VERSE_AUDIO_NOT_FOUND) {
    return existing;
  }

  // First recording for this unit — create clean unit + take.
  if (!existing.ok) {
    const stored = await storeTakeBytes(
      input.projectUnitId,
      input.bibleTextId,
      contentHash,
      input.data,
      input.contentType
    );
    if (!stored.ok) {
      return stored;
    }

    // Insert-only: concurrent first-upload races reload the winner, never overwrite.
    const created = await repo.insertRecording({
      projectUnitId: input.projectUnitId,
      bibleTextId: input.bibleTextId,
      uploadedBy: input.uploadedBy,
      storageObjectId: stored.data.storageObjectId,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      durationSeconds,
      versionToken: 1,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      activeTakeId: null,
    });
    if (!created.ok) {
      return created;
    }

    const take = await repo.insertTake({
      recordingId: created.data.id,
      uploadedBy: input.uploadedBy,
      storageObjectId: stored.data.storageObjectId,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      durationSeconds,
      contentHash,
    });
    if (!take.ok) {
      return take;
    }

    // If another writer already finished this unit, keep their active take and
    // surface our take as a conflict instead of clobbering version state.
    // Identical bytes that reloaded the winner's own active take are idempotent.
    if (created.data.activeTakeId !== null || created.data.versionToken !== 1) {
      if (take.data.id === created.data.activeTakeId) {
        return loadUnitResponse(input.projectUnitId, input.bibleTextId);
      }
      const marked = await repo.markConflictPreservingActive(created.data.id);
      if (!marked.ok) {
        return marked;
      }
      return loadUnitResponse(input.projectUnitId, input.bibleTextId);
    }

    const linked = await repo.updateRecordingStateIfVersion(
      created.data.id,
      1,
      {
        activeTakeId: take.data.id,
        uploadedBy: input.uploadedBy,
        storageObjectId: stored.data.storageObjectId,
        contentType: input.contentType,
        sizeBytes: input.data.length,
        durationSeconds,
        versionToken: 2,
      },
      { requireNullActiveTake: true }
    );
    if (!linked.ok) {
      return linked;
    }
    if (!linked.data.applied) {
      // Same-bytes race: winner already linked our take (via onConflictDoNothing).
      const current = await repo.get(input.projectUnitId, input.bibleTextId);
      if (current.ok && current.data.activeTakeId === take.data.id) {
        return loadUnitResponse(input.projectUnitId, input.bibleTextId);
      }
      const marked = await repo.markConflictPreservingActive(created.data.id);
      if (!marked.ok) {
        return marked;
      }
    }

    return loadUnitResponse(input.projectUnitId, input.bibleTextId);
  }

  const unit = existing.data;

  const tokenSupplied = input.baseVersionToken !== undefined;
  const baseMatches = tokenSupplied && input.baseVersionToken === unit.versionToken;
  const legacyReplace = !tokenSupplied;

  // Idempotent retry / intentional revert onto an existing take's bytes.
  const duplicate = await repo.findTakeByContentHash(unit.id, contentHash);
  if (!duplicate.ok) {
    return duplicate;
  }

  if (duplicate.data) {
    if (duplicate.data.id === unit.activeTakeId) {
      return loadUnitResponse(input.projectUnitId, input.bibleTextId);
    }

    if (baseMatches || legacyReplace) {
      const promoted = await repo.updateRecordingStateIfVersion(unit.id, unit.versionToken, {
        uploadedBy: duplicate.data.uploadedBy,
        storageObjectId: duplicate.data.storageObjectId,
        contentType: duplicate.data.contentType,
        sizeBytes: duplicate.data.sizeBytes,
        durationSeconds: duplicate.data.durationSeconds,
        versionToken: unit.versionToken + 1,
        conflictStatus: legacyReplace
          ? unit.conflictStatus
          : VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
        activeTakeId: duplicate.data.id,
      });
      if (!promoted.ok) {
        return promoted;
      }
      if (!promoted.data.applied) {
        const marked = await repo.markConflictPreservingActive(unit.id);
        if (!marked.ok) {
          return marked;
        }
      }
      return loadUnitResponse(input.projectUnitId, input.bibleTextId);
    }

    const marked = await repo.markConflictPreservingActive(unit.id);
    if (!marked.ok) {
      return marked;
    }
    return loadUnitResponse(input.projectUnitId, input.bibleTextId);
  }

  const stored = await storeTakeBytes(
    input.projectUnitId,
    input.bibleTextId,
    contentHash,
    input.data,
    input.contentType
  );
  if (!stored.ok) {
    return stored;
  }

  const take = await repo.insertTake({
    recordingId: unit.id,
    uploadedBy: input.uploadedBy,
    storageObjectId: stored.data.storageObjectId,
    contentType: input.contentType,
    sizeBytes: input.data.length,
    durationSeconds,
    contentHash,
  });
  if (!take.ok) {
    return take;
  }

  const nextVersion = unit.versionToken + 1;
  const observedVersion = unit.versionToken;

  if (baseMatches || legacyReplace) {
    const updated = await repo.updateRecordingStateIfVersion(unit.id, observedVersion, {
      uploadedBy: input.uploadedBy,
      storageObjectId: stored.data.storageObjectId,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      durationSeconds,
      versionToken: nextVersion,
      conflictStatus: legacyReplace ? unit.conflictStatus : VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      activeTakeId: take.data.id,
    });
    if (!updated.ok) {
      return updated;
    }
    if (!updated.data.applied) {
      // Newer state won the race — keep our take, flag conflict, don't clobber.
      const marked = await repo.markConflictPreservingActive(unit.id);
      if (!marked.ok) {
        return marked;
      }
    }
  } else {
    // Stale base: keep prior active take, mark conflict, still bump token.
    const updated = await repo.updateRecordingStateIfVersion(unit.id, observedVersion, {
      versionToken: nextVersion,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
    });
    if (!updated.ok) {
      return updated;
    }
    if (!updated.data.applied) {
      const marked = await repo.markConflictPreservingActive(unit.id);
      if (!marked.ok) {
        return marked;
      }
    }
  }

  return loadUnitResponse(input.projectUnitId, input.bibleTextId);
}

export async function getRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<VerseAudioWithUrl>> {
  return loadUnitResponse(projectUnitId, bibleTextId);
}

export async function listChapterRecordings(
  projectUnitId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<{ items: VerseAudioWithUrl[]; hasConflict: boolean }>> {
  const result = await repo.listByChapter(projectUnitId, bookId, chapterNumber);
  if (!result.ok) {
    return result;
  }

  const takes = await repo.listTakesByRecordingIds(result.data.map((r) => r.id));
  if (!takes.ok) {
    return takes;
  }

  const takesByRecording = new Map<number, VerseAudioTakeRecord[]>();
  for (const take of takes.data) {
    const list = takesByRecording.get(take.recordingId) ?? [];
    list.push(take);
    takesByRecording.set(take.recordingId, list);
  }

  const items = await buildRecordingResponses(
    result.data.map((record) => ({
      record,
      takes: takesByRecording.get(record.id) ?? [],
    }))
  );

  const hasConflict = items.some(
    (item) => item.conflictStatus === VERSE_AUDIO_CONFLICT_STATUS.CONFLICT
  );

  return ok({ items, hasConflict });
}

export async function resolveConflict(
  input: ResolveConflictInput
): Promise<Result<VerseAudioWithUrl>> {
  const recording = await repo.get(input.projectUnitId, input.bibleTextId);
  if (!recording.ok) {
    return recording;
  }

  const take = await repo.getTakeById(input.takeId);
  if (!take.ok) {
    return take;
  }
  if (take.data.recordingId !== recording.data.id) {
    return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
  }

  const updated = await repo.updateRecordingStateIfVersion(
    recording.data.id,
    recording.data.versionToken,
    {
      uploadedBy: take.data.uploadedBy,
      storageObjectId: take.data.storageObjectId,
      contentType: take.data.contentType,
      sizeBytes: take.data.sizeBytes,
      durationSeconds: take.data.durationSeconds,
      activeTakeId: take.data.id,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CLEAN,
      versionToken: recording.data.versionToken + 1,
    }
  );
  if (!updated.ok) {
    return updated;
  }
  if (!updated.data.applied) {
    // Concurrent upload advanced the token — client should reload and retry.
    return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
  }

  return loadUnitResponse(input.projectUnitId, input.bibleTextId);
}

export async function deleteRecording(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<void>> {
  const existing = await repo.get(projectUnitId, bibleTextId);
  if (!existing.ok) {
    return existing;
  }

  const takes = await repo.listTakesForRecording(existing.data.id);
  if (!takes.ok) {
    return takes;
  }

  // Row first (cascades takes), bytes second. If the row write fails nothing has
  // been destroyed and the caller can retry; if an object delete then fails, the
  // storage row is an orphan and the sweep collects it.
  const removed = await repo.remove(projectUnitId, bibleTextId);
  if (!removed.ok) {
    return removed;
  }

  for (const take of takes.data) {
    if (take.storageObjectId === null) {
      continue;
    }
    const storage = await storageRepo.getById(take.storageObjectId);
    const key = storage.ok
      ? storage.data.key
      : fallbackBlobKey(projectUnitId, bibleTextId, take.contentHash);

    try {
      await deleteVerseAudio(key);
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Verse audio object delete failed; left for the reclaim sweep',
        context: { key },
      });
      continue;
    }

    await storageRepo.markDeleted(take.storageObjectId);
  }

  return ok(undefined);
}

/**
 * Deletes objects nothing references any more and stamps their rows.
 *
 * This is the counterpart to the cascade: dropping a project unit cascades its
 * recordings away, but Postgres cannot touch a bucket, so without this the audio
 * would sit there forever. Runs on an interval from the server entrypoint.
 */
export async function reclaimOrphanedStorageObjects(): Promise<Result<number>> {
  const orphans = await storageRepo.findOrphans(env.AUDIO_RECLAIM_GRACE_MS);
  if (!orphans.ok) {
    return orphans;
  }

  let reclaimed = 0;
  for (const orphan of orphans.data) {
    try {
      await deleteVerseAudio(orphan.key);
    } catch (error) {
      // Leave the row unstamped so the next sweep retries this object.
      logger.error({
        cause: error,
        message: 'Failed to reclaim orphaned storage object',
        context: { bucket: orphan.bucket, key: orphan.key },
      });
      continue;
    }
    await storageRepo.markDeleted(orphan.id);
    reclaimed++;
  }

  if (reclaimed > 0) {
    logger.info('Reclaimed orphaned verse audio objects', { reclaimed });
  }
  return ok(reclaimed);
}
