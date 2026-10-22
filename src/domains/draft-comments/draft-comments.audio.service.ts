import type { Buffer } from 'node:buffer';

import { createHash } from 'node:crypto';

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
  // Only the object this attempt uploaded — never pending placeholders or other keys.
  if (!key || !isCommentAudioKey(key) || key.startsWith('comments/pending/')) return;
  await deleteVerseAudio(key).catch(() => undefined);
}

/**
 * Create a root audio comment, or a one-level audio reply when `replyToCommentId` is set.
 * Replies flatten onto the root, inherit the root's immutable anchor + connectionState
 * (including retained Unconnected), and ignore any caller-supplied anchor.
 * Target resolution and auth run before any storage call.
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
    // Resolve target in the authorized chapter/project before any storage call.
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
    // Caller anchor (if any) is ignored — reply inherits the root snapshot.
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
  let uploadedKey: string | null = null;
  /**
   * True once the tx callback returns a successful updated row. Distinct from observed
   * outer commit: a lost COMMIT ack must not treat this as a known rollback.
   */
  let callbackSucceeded = false;
  let committedRow: Awaited<ReturnType<typeof repo.finalizeCommentAudioKey>> | null = null;

  try {
    // Map outside the write transaction so author/display reads never use a second
    // connection against an open tx (PGlite single-connection deadlock).
    const result = await runInTransaction(async (tx) => {
      // Insert with a non-final key so CHECK passes; roll back removes the row if
      // upload/update fails (no retained pending comment).
      const pendingKey = `comments/pending/${assignment.projectId}/${contentHash}`;
      const placeholder = await repo.insertComment(
        {
          projectId: assignment.projectId,
          chapterAssignmentId,
          authorUserId: user.id,
          parentCommentId,
          bodyKind: COMMENT_BODY_KIND.AUDIO,
          bodyText: null,
          emoji: null,
          audioStorageKey: pendingKey,
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

      const key = commentAudioBlobName(assignment.projectId, placeholder.id, contentHash);
      try {
        await uploadVerseAudio(key, file.data, file.contentType);
        uploadedKey = key;
      } catch {
        return err(ErrorCode.COMMENT_AUDIO_STORAGE_UNAVAILABLE);
      }

      const updated = await repo.finalizeCommentAudioKey(placeholder.id, key, tx);
      if (!updated) {
        return err(ErrorCode.INTERNAL_ERROR);
      }
      callbackSucceeded = true;
      return ok(updated);
    });

    if (!result.ok) {
      // Known Result rollback (callback returned err → TransactionAbort).
      await cleanupUploadedCommentAudio(uploadedKey);
      return result;
    }
    committedRow = result.data;
  } catch {
    // Outer throw after callback success ⇒ COMMIT outcome unknown — preserve object.
    // Finalize/upload failure before callback success ⇒ known aborted write — clean.
    if (!callbackSucceeded) {
      await cleanupUploadedCommentAudio(uploadedKey);
    }
    return err(ErrorCode.INTERNAL_ERROR);
  }

  try {
    return ok(await mapCommentRow(committedRow!, [], user.id, roleDisplay));
  } catch {
    // Post-commit mapping/display failure — row + object stay; never delete referenced audio.
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
