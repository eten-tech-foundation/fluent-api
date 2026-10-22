import type { Buffer } from 'node:buffer';

import { createHash } from 'node:crypto';

import type { Result } from '@/lib/types';

import { audioBlobName, audioBucket, uploadVerseAudio } from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  UploadRecordingInput,
  VerseAudioCoverageShape,
  VerseAudioWithUrl,
} from './verse-audio.types';

import * as storageRepo from './storage-objects.repository';
import { coverageFromActive, rangesEqual } from './verse-audio.coverage';
import * as repo from './verse-audio.repository';
import { loadUnitResponse } from './verse-audio.responses';
import { shapeFields, shapeFromRecord, shapeFromTake, shapesEqual } from './verse-audio.shapes';
import {
  ALLOWED_AUDIO_CONTENT_TYPES,
  VERSE_AUDIO_CONFLICT_STATUS,
  VERSE_COVERAGE_SHAPE,
} from './verse-audio.types';

function contentHashOf(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function applyCoverageConflictsAfterUpload(
  projectUnitId: number,
  bibleTextId: number,
  shape: VerseAudioCoverageShape
): Promise<Result<void>> {
  const bibleText = await repo.getBibleTextById(bibleTextId);
  if (!bibleText.ok) {
    return bibleText;
  }

  const coverage = coverageFromActive(
    shape,
    bibleText.data.chapterNumber,
    bibleText.data.verseNumber
  );

  const marked = await repo.markIntersectingCoverageConflicts({
    projectUnitId,
    selfBibleTextId: bibleTextId,
    bookId: bibleText.data.bookId,
    coverage,
  });
  if (!marked.ok) {
    return marked;
  }
  return ok(undefined);
}

/**
 * Load the unit response after upload. When `scanCoverageConflicts` is true,
 * mark intersecting same-book recordings (and self) as conflict. Skip when the
 * upload did not change active geometric coverage and did not insert a new
 * contender (e.g. same-shape retry or activeTakeId-only promote).
 */
async function finishUploadResponse(
  projectUnitId: number,
  bibleTextId: number,
  shape: VerseAudioCoverageShape,
  options: { scanCoverageConflicts: boolean }
): Promise<Result<VerseAudioWithUrl>> {
  if (options.scanCoverageConflicts) {
    const conflicts = await applyCoverageConflictsAfterUpload(projectUnitId, bibleTextId, shape);
    if (!conflicts.ok) {
      return conflicts;
    }
  }
  return loadUnitResponse(projectUnitId, bibleTextId);
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

  const shape = shapeFields(input.shape ?? VERSE_COVERAGE_SHAPE);
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
        ...shape,
      },
      {
        uploadedBy: input.uploadedBy,
        storageObjectId: stored.data.storageObjectId,
        contentType: input.contentType,
        sizeBytes: input.data.length,
        durationSeconds,
        contentHash,
        ...shape,
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

    return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
      scanCoverageConflicts: true,
    });
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
  const duplicate = await repo.findTakeByContentHash(unit.id, contentHash);
  if (!duplicate.ok) {
    return duplicate;
  }

  if (duplicate.data) {
    const existingShape = shapeFromTake(duplicate.data);
    // Full shape (incl. granularity) — drives take/recording metadata rewrites.
    const shapeMismatch = !shapesEqual(existingShape, shape);
    // Overlap scan is geometric only: verse ↔ one-verse pericope at the same
    // anchor bounds must not re-flag a resolved CLEAN unit.
    const activeGeometryChanged = !rangesEqual(
      coverageFromActive(shapeFromRecord(unit), unit.chapterNumber, unit.verseNumber),
      coverageFromActive(shape, unit.chapterNumber, unit.verseNumber)
    );

    // Same bytes as the active take: idempotent unless coverage metadata changed.
    if (duplicate.data.id === unit.activeTakeId) {
      if (!shapeMismatch) {
        // Unchanged retry — do not re-scan overlaps (would re-flag resolved CLEAN).
        return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
          scanCoverageConflicts: false,
        });
      }
      if (baseMatches || legacyReplace) {
        const promoted = await repo.updateTakeCoverageAndRecordingIfVersion(
          duplicate.data.id,
          unit.id,
          unit.versionToken,
          shape,
          {
            versionToken: unit.versionToken + 1,
            ...shape,
          }
        );
        if (!promoted.ok) {
          return promoted;
        }
        if (!promoted.data.applied) {
          // Coverage change did not apply (txn rolled back). Do not report 200
          // success or reopen conflict — same 409 contract as resolve CAS miss.
          return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
        }
        return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
          scanCoverageConflicts: activeGeometryChanged,
        });
      }
      // Stale token + shape change on the active take's bytes: do not overwrite
      // coverage under a stale base; flag unit conflict only (no geometric re-scan).
      const marked = await repo.markConflictPreservingActive(unit.id);
      if (!marked.ok) {
        return marked;
      }
      return finishUploadResponse(input.projectUnitId, input.bibleTextId, existingShape, {
        scanCoverageConflicts: false,
      });
    }

    if (baseMatches || legacyReplace) {
      if (shapeMismatch) {
        const promoted = await repo.updateTakeCoverageAndRecordingIfVersion(
          duplicate.data.id,
          unit.id,
          unit.versionToken,
          shape,
          {
            uploadedBy: duplicate.data.uploadedBy,
            storageObjectId: duplicate.data.storageObjectId,
            contentType: duplicate.data.contentType,
            sizeBytes: duplicate.data.sizeBytes,
            durationSeconds: duplicate.data.durationSeconds,
            versionToken: unit.versionToken + 1,
            activeTakeId: duplicate.data.id,
            ...shape,
          }
        );
        if (!promoted.ok) {
          return promoted;
        }
        if (!promoted.data.applied) {
          // Failed coverage promote — 409, preserve takes / conflictStatus as-is.
          return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
        }
        return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
          scanCoverageConflicts: activeGeometryChanged,
        });
      }

      const promoted = await repo.updateRecordingStateIfVersion(unit.id, unit.versionToken, {
        uploadedBy: duplicate.data.uploadedBy,
        storageObjectId: duplicate.data.storageObjectId,
        contentType: duplicate.data.contentType,
        sizeBytes: duplicate.data.sizeBytes,
        durationSeconds: duplicate.data.durationSeconds,
        versionToken: unit.versionToken + 1,
        activeTakeId: duplicate.data.id,
        ...shape,
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
      // activeTakeId-only promote (geometry unchanged) must not re-flag CLEAN.
      return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
        scanCoverageConflicts: activeGeometryChanged,
      });
    }

    // Stale token + duplicate of a non-active take: no new contender was added.
    return finishUploadResponse(
      input.projectUnitId,
      input.bibleTextId,
      {
        granularity: unit.granularity,
        startChapter: unit.startChapter,
        startVerse: unit.startVerse,
        endChapter: unit.endChapter,
        endVerse: unit.endVerse,
      },
      { scanCoverageConflicts: false }
    );
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
    ...shape,
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
      ...shape,
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

  // New take inserted (matching or stale base) — always scan overlaps.
  return finishUploadResponse(input.projectUnitId, input.bibleTextId, shape, {
    scanCoverageConflicts: true,
  });
}
