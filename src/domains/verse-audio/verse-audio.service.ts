import type { Buffer } from 'node:buffer';

import { createHash } from 'node:crypto';

import type { Result } from '@/lib/types';

import {
  audioBlobName,
  audioBucket,
  deleteVerseAudio,
  uploadVerseAudio,
} from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  ResolveConflictInput,
  UploadRecordingInput,
  VerseAudioTakeRecord,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import * as repo from './verse-audio.repository';
import {
  buildRecordingResponses,
  fallbackBlobKey,
  loadUnitResponse,
} from './verse-audio.responses';
import { ALLOWED_AUDIO_CONTENT_TYPES, VERSE_AUDIO_CONFLICT_STATUS } from './verse-audio.types';

function contentHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
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

  // First recording for this unit — create clean unit + take in one transaction
  // so a concurrent GET cannot observe takes:[] while downloadUrl still works.
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

    const created = await repo.createFirstRecordingWithTake(
      {
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
      },
      {
        uploadedBy: input.uploadedBy,
        storageObjectId: stored.data.storageObjectId,
        contentType: input.contentType,
        sizeBytes: input.data.length,
        durationSeconds,
        contentHash,
      }
    );
    if (!created.ok) {
      return created;
    }

    // Race loser: keep the winner's active take and surface ours as a conflict,
    // unless the identical bytes already became active (idempotent retry).
    if (created.data.outcome === 'concurrent') {
      if (created.data.take.id !== created.data.record.activeTakeId) {
        const marked = await repo.markConflictPreservingActive(created.data.record.id);
        if (!marked.ok) {
          return marked;
        }
      }
    }

    return loadUnitResponse(input.projectUnitId, input.bibleTextId);
  }

  const unit = existing.data;

  // Three cases: a matching token replaces the active take, an absent token does
  // the same on behalf of clients too old to send one, and a stale token keeps
  // both takes and flags a conflict. None of them clears an open conflict — that
  // is resolve's job alone, so a losing client cannot settle a contest in its own
  // favour just by retrying with the token the conflict response handed it.
  const tokenSupplied = input.baseVersionToken !== undefined;
  const baseMatches = tokenSupplied && input.baseVersionToken === unit.versionToken;
  const legacyReplace = !tokenSupplied;

  if (legacyReplace) {
    // Temporary escape hatch for un-upgraded clients. Count/log so we can retire
    // it once mobile builds all send baseVersionToken.
    logger.info(
      {
        event: 'verse_audio_upload_legacy_no_token',
        projectUnitId: input.projectUnitId,
        bibleTextId: input.bibleTextId,
        recordingId: unit.id,
      },
      'Verse audio upload omitted baseVersionToken; using deprecated legacy replace'
    );
  }

  // Idempotent retry / intentional revert onto an existing take's bytes.
  const duplicate = await takesRepo.findTakeByContentHash(unit.id, contentHash);
  if (!duplicate.ok) {
    return duplicate;
  }

  if (duplicate.data) {
    // Re-sending the active take's own bytes changes nothing, including the
    // conflict flag: only resolve clears that.
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
        activeTakeId: duplicate.data.id,
      });
      if (!promoted.ok) {
        return promoted;
      }
      if (!promoted.data.applied) {
        // No new take was added on this path. A successful concurrent resolve
        // may have won the CAS, so reopening its clean or resolved state would
        // undo an explicit adjudication without introducing any new contender.
        return loadUnitResponse(input.projectUnitId, input.bibleTextId);
      }
      return loadUnitResponse(input.projectUnitId, input.bibleTextId);
    }

    // Stale token + duplicate of a non-active take: no new contender was added.
    // Returning current state (rather than markConflictPreservingActive) preserves
    // a concurrent /resolve that already adjudicated these same takes.
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

  const take = await takesRepo.insertTake({
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
    // conflictStatus is deliberately absent from the patch: an upload may take
    // over as the active take, but only resolve adjudicates an open conflict.
    const updated = await repo.updateRecordingStateIfVersion(unit.id, observedVersion, {
      uploadedBy: input.uploadedBy,
      storageObjectId: stored.data.storageObjectId,
      contentType: input.contentType,
      sizeBytes: input.data.length,
      durationSeconds,
      versionToken: nextVersion,
      activeTakeId: take.data.id,
    });
    if (!updated.ok) {
      return updated;
    }
    if (!updated.data.applied) {
      // Newer state won the race — keep our take, advance versionToken, and mark
      // conflict without clobbering the winner's active take. If the winner was a
      // concurrent resolve, markConflictPreservingActive preserves its 'resolved'
      // status so the manager's adjudication is not undone.
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
      // CAS miss on stale-base update: bump versionToken and mark conflict,
      // preserving an intervening resolve if one settled the unit.
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

/** Lightweight reload for 409 retry hints — no presigns or take hydration. */
export async function getCurrentVersionToken(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<number>> {
  const recording = await repo.get(projectUnitId, bibleTextId);
  if (!recording.ok) {
    return recording;
  }
  return ok(recording.data.versionToken);
}

export async function listChapterRecordings(
  projectUnitId: number,
  bibleId: number,
  bookId: number,
  chapterNumber: number
): Promise<Result<{ items: VerseAudioWithUrl[]; hasConflict: boolean }>> {
  const result = await repo.listByChapter(projectUnitId, bibleId, bookId, chapterNumber);
  if (!result.ok) {
    return result;
  }

  const takes = await takesRepo.listTakesByRecordingIds(result.data.map((r) => r.id));
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

  const take = await takesRepo.getTakeById(input.takeId);
  if (!take.ok) {
    return take;
  }
  if (take.data.recordingId !== recording.data.id) {
    return err(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
  }

  // Reject resolve on units that are not actively conflicted. Allowing it would
  // silently stamp 'resolved' on a clean or already-resolved unit, which makes
  // clients show "conflict resolved" when no conflict ever existed (or was
  // already settled). The caller should reload and check conflictStatus first.
  if (recording.data.conflictStatus !== VERSE_AUDIO_CONFLICT_STATUS.CONFLICT) {
    return err(ErrorCode.VERSE_AUDIO_NOT_IN_CONFLICT);
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
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.RESOLVED,
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

  const takes = await takesRepo.listTakesForRecording(existing.data.id);
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

export { reclaimOrphanedStorageObjects } from './verse-audio.reclaim.service';
