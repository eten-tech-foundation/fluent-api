import type { Buffer } from 'node:buffer';

import { createHash, randomUUID } from 'node:crypto';

import type { AppPolicyUser, Result } from '@/lib/types';

import { runInTransaction } from '@/db/transaction';
import { deleteVerseAudio, isAudioStorageAvailable, uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterCommentResponse, CommentAnchorInput } from './draft-comments.types';

import { resolveAnchorSnapshot } from './draft-comments.anchors';
import { commentAudioBlobName, isCommentAudioKey } from './draft-comments.audio';
import { mapCommentRow } from './draft-comments.map';
import { DraftCommentPolicy } from './draft-comments.policy';
import * as repo from './draft-comments.repository';
import {
  ALLOWED_COMMENT_AUDIO_CONTENT_TYPES,
  COMMENT_BODY_KIND,
  COMMENT_CONNECTION_STATE,
  MAX_COMMENT_AUDIO_BYTES,
} from './draft-comments.types';

/** Engineering default max duration (seconds) for comment clips. */
const MAX_COMMENT_AUDIO_DURATION_SECONDS = 30 * 60;

async function cleanupUploadedCommentAudio(key: string | null): Promise<void> {
  if (!key || !isCommentAudioKey(key) || key.startsWith('comments/pending/')) return;
  await deleteVerseAudio(key).catch(() => undefined);
}

function denyWrite(
  user: AppPolicyUser,
  assignment: { organizationId: number; projectId: number }
): Result<never> | null {
  if (
    !DraftCommentPolicy.read(user, {
      organizationId: assignment.organizationId,
      projectId: assignment.projectId,
    })
  ) {
    return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  }
  if (
    !DraftCommentPolicy.write(user, {
      organizationId: assignment.organizationId,
      projectId: assignment.projectId,
    })
  ) {
    return err(ErrorCode.FORBIDDEN);
  }
  return null;
}

/**
 * Create a root audio comment, or a one-level audio reply when `replyToCommentId` is set.
 * Network upload runs outside any DB transaction; a short write tx revalidates
 * assignment/target/source state after upload so mid-upload mutations cannot create a
 * falsely connected or cross-project row.
 */
export async function createAudioComment(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  anchor: CommentAnchorInput | null,
  file: { data: Buffer; contentType: string; durationSeconds?: number | null },
  roleDisplay: string | null = null,
  replyToCommentId: number | null = null
): Promise<Result<ChapterCommentResponse>> {
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  const denied = denyWrite(user, assignment);
  if (denied) return denied;
  if (!isAudioStorageAvailable()) return err(ErrorCode.COMMENT_AUDIO_STORAGE_UNAVAILABLE);
  if (file.data.length === 0) return err(ErrorCode.EMPTY_AUDIO_FILE);
  if (file.data.length > MAX_COMMENT_AUDIO_BYTES) return err(ErrorCode.VALIDATION_ERROR);
  if (!ALLOWED_COMMENT_AUDIO_CONTENT_TYPES.has(file.contentType)) {
    return err(ErrorCode.UNSUPPORTED_AUDIO_TYPE);
  }
  if (file.durationSeconds != null) {
    const duration = file.durationSeconds;
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      duration > MAX_COMMENT_AUDIO_DURATION_SECONDS
    ) {
      return err(ErrorCode.VALIDATION_ERROR);
    }
  }

  let parentCommentId: number | null = null;
  let anchorKind: 'verse' | 'pericope';
  let anchorBibleId: number;
  let anchorBookId: number;
  let anchorChapterNumber: number;
  let anchorBibleTextId: number | null;
  let anchorVerseNumber: number | null;
  let anchorPericopeSetId: number | null;
  let anchorPericopeNumber: string | null;
  let anchorPericopeTitle: string | null;
  let connectionState: 'connected' | 'unconnected';

  if (replyToCommentId != null) {
    const target = await repo.findCommentById(replyToCommentId);
    if (
      !target ||
      target.chapterAssignmentId !== chapterAssignmentId ||
      target.projectId !== assignment.projectId
    ) {
      return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
    }
    const rootId = target.parentCommentId ?? target.id;
    const root = target.parentCommentId == null ? target : await repo.findCommentById(rootId);
    if (
      !root ||
      root.chapterAssignmentId !== chapterAssignmentId ||
      root.projectId !== assignment.projectId
    ) {
      return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
    }
    parentCommentId = rootId;
    anchorKind = root.anchorKind;
    anchorBibleId = root.anchorBibleId;
    anchorBookId = root.anchorBookId;
    anchorChapterNumber = root.anchorChapterNumber;
    anchorBibleTextId = root.anchorBibleTextId;
    anchorVerseNumber = root.anchorVerseNumber;
    anchorPericopeSetId = root.anchorPericopeSetId;
    anchorPericopeNumber = root.anchorPericopeNumber;
    anchorPericopeTitle = root.anchorPericopeTitle;
    connectionState = root.connectionState;
  } else {
    if (!anchor) return err(ErrorCode.VALIDATION_ERROR);
    const bibleText =
      anchor.kind === 'verse' ? await repo.findBibleTextById(anchor.bibleTextId) : null;
    const pericopeMembership =
      anchor.kind === 'pericope' && assignment.pericopeSetId != null
        ? await repo.findPericopeMembership(
            assignment.pericopeSetId,
            assignment.bookId,
            assignment.chapterNumber,
            anchor.pericopeNumber
          )
        : null;
    const snapshot = resolveAnchorSnapshot(
      anchor,
      {
        projectId: assignment.projectId,
        bibleId: assignment.bibleId,
        bookId: assignment.bookId,
        chapterNumber: assignment.chapterNumber,
        pericopeSetId: assignment.pericopeSetId,
      },
      bibleText,
      pericopeMembership
    );
    if ('error' in snapshot) return err(ErrorCode.INVALID_REFERENCE);
    anchorKind = snapshot.kind;
    anchorBibleId = snapshot.bibleId;
    anchorBookId = snapshot.bookId;
    anchorChapterNumber = snapshot.chapterNumber;
    anchorBibleTextId = snapshot.bibleTextId;
    anchorVerseNumber = snapshot.verseNumber;
    anchorPericopeSetId = snapshot.pericopeSetId;
    anchorPericopeNumber = snapshot.pericopeNumber;
    anchorPericopeTitle = snapshot.pericopeTitle;
    connectionState = COMMENT_CONNECTION_STATE.CONNECTED;
  }

  const contentHash = createHash('sha256').update(file.data).digest('hex');
  const objectId = randomUUID();
  const key = commentAudioBlobName(assignment.projectId, objectId, contentHash);
  let uploadedKey: string | null = null;

  try {
    await uploadVerseAudio(key, file.data, file.contentType);
    uploadedKey = key;
  } catch {
    return err(ErrorCode.COMMENT_AUDIO_STORAGE_UNAVAILABLE);
  }

  /** Set once the short write callback returns ok(row). */
  let callbackSucceeded = false;
  let committedRow: Awaited<ReturnType<typeof repo.insertComment>> | null = null;

  try {
    const result = await runInTransaction(async (tx) => {
      // Revalidate after upload — reject if assignment/target/source drifted mid-upload.
      const liveAssignment = await repo.findAssignmentContext(chapterAssignmentId, tx);
      if (!liveAssignment || liveAssignment.projectId !== assignment.projectId) {
        return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
      }
      const liveDenied = denyWrite(user, liveAssignment);
      if (liveDenied) return liveDenied;

      if (replyToCommentId != null && parentCommentId != null) {
        const root = await repo.findCommentById(parentCommentId, tx);
        if (
          !root ||
          root.chapterAssignmentId !== chapterAssignmentId ||
          root.projectId !== liveAssignment.projectId ||
          root.parentCommentId != null
        ) {
          return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
        }
        // Refresh inherited snapshot + connectionState from live root (truthful Unconnected).
        anchorKind = root.anchorKind;
        anchorBibleId = root.anchorBibleId;
        anchorBookId = root.anchorBookId;
        anchorChapterNumber = root.anchorChapterNumber;
        anchorBibleTextId = root.anchorBibleTextId;
        anchorVerseNumber = root.anchorVerseNumber;
        anchorPericopeSetId = root.anchorPericopeSetId;
        anchorPericopeNumber = root.anchorPericopeNumber;
        anchorPericopeTitle = root.anchorPericopeTitle;
        connectionState = root.connectionState;
      } else if (anchor) {
        const bibleText =
          anchor.kind === 'verse' ? await repo.findBibleTextById(anchor.bibleTextId, tx) : null;
        const pericopeMembership =
          anchor.kind === 'pericope' && liveAssignment.pericopeSetId != null
            ? await repo.findPericopeMembership(
                liveAssignment.pericopeSetId,
                liveAssignment.bookId,
                liveAssignment.chapterNumber,
                anchor.pericopeNumber,
                tx
              )
            : null;
        const snapshot = resolveAnchorSnapshot(
          anchor,
          {
            projectId: liveAssignment.projectId,
            bibleId: liveAssignment.bibleId,
            bookId: liveAssignment.bookId,
            chapterNumber: liveAssignment.chapterNumber,
            pericopeSetId: liveAssignment.pericopeSetId,
          },
          bibleText,
          pericopeMembership
        );
        if ('error' in snapshot) return err(ErrorCode.INVALID_REFERENCE);
        anchorKind = snapshot.kind;
        anchorBibleId = snapshot.bibleId;
        anchorBookId = snapshot.bookId;
        anchorChapterNumber = snapshot.chapterNumber;
        anchorBibleTextId = snapshot.bibleTextId;
        anchorVerseNumber = snapshot.verseNumber;
        anchorPericopeSetId = snapshot.pericopeSetId;
        anchorPericopeNumber = snapshot.pericopeNumber;
        anchorPericopeTitle = snapshot.pericopeTitle;
        connectionState = COMMENT_CONNECTION_STATE.CONNECTED;
      }

      const row = await repo.insertComment(
        {
          projectId: liveAssignment.projectId,
          chapterAssignmentId,
          authorUserId: user.id,
          parentCommentId,
          bodyKind: COMMENT_BODY_KIND.AUDIO,
          bodyText: null,
          emoji: null,
          audioStorageKey: key,
          audioContentType: file.contentType,
          audioByteSize: file.data.length,
          audioDurationSeconds: file.durationSeconds ?? null,
          audioContentHash: contentHash,
          anchorKind,
          anchorBibleId,
          anchorBookId,
          anchorChapterNumber,
          anchorBibleTextId,
          anchorVerseNumber,
          anchorPericopeSetId,
          anchorPericopeNumber,
          anchorPericopeTitle,
          connectionState,
        },
        tx
      );
      callbackSucceeded = true;
      return ok(row);
    });

    if (!result.ok) {
      await cleanupUploadedCommentAudio(uploadedKey);
      return result;
    }
    committedRow = result.data;
  } catch {
    if (!callbackSucceeded) {
      await cleanupUploadedCommentAudio(uploadedKey);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }

  try {
    return ok(await mapCommentRow(committedRow!, [], user.id, roleDisplay));
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
