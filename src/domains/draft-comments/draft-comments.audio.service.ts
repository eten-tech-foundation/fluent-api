import type { Buffer } from 'node:buffer';

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';

import type { AppPolicyUser, Result } from '@/lib/types';

import { chapter_comments } from '@/db/draft-comments.schema';
import { runInTransaction } from '@/db/transaction';
import { deleteVerseAudio, isAudioStorageAvailable, uploadVerseAudio } from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterCommentResponse, CommentAnchorInput } from './draft-comments.types';

import { resolveAnchorSnapshot } from './draft-comments.anchors';
import { commentAudioBlobName } from './draft-comments.audio';
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

export async function createAudioComment(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  anchor: CommentAnchorInput,
  file: { data: Buffer; contentType: string; durationSeconds?: number | null },
  roleDisplay: string | null = null
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
  if (
    file.durationSeconds != null &&
    (file.durationSeconds < 0 || file.durationSeconds > MAX_COMMENT_AUDIO_DURATION_SECONDS)
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }

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

  const contentHash = createHash('sha256').update(file.data).digest('hex');

  return runInTransaction(async (tx) => {
    // Insert with a non-final key so CHECK passes; roll back removes the row if
    // upload/update fails (no retained pending comment).
    const pendingKey = `comments/pending/${assignment.projectId}/${contentHash}`;
    const placeholder = await repo.insertComment(
      {
        projectId: assignment.projectId,
        chapterAssignmentId,
        authorUserId: user.id,
        parentCommentId: null,
        bodyKind: COMMENT_BODY_KIND.AUDIO,
        bodyText: null,
        emoji: null,
        audioStorageKey: pendingKey,
        audioContentType: file.contentType,
        audioByteSize: file.data.length,
        audioDurationSeconds: file.durationSeconds ?? null,
        audioContentHash: contentHash,
        anchorKind: snapshot.kind,
        anchorBibleId: snapshot.bibleId,
        anchorBookId: snapshot.bookId,
        anchorChapterNumber: snapshot.chapterNumber,
        anchorBibleTextId: snapshot.bibleTextId,
        anchorVerseNumber: snapshot.verseNumber,
        anchorPericopeSetId: snapshot.pericopeSetId,
        anchorPericopeNumber: snapshot.pericopeNumber,
        anchorPericopeTitle: snapshot.pericopeTitle,
        connectionState: COMMENT_CONNECTION_STATE.CONNECTED,
      },
      tx
    );

    const key = commentAudioBlobName(assignment.projectId, placeholder.id, contentHash);
    try {
      await uploadVerseAudio(key, file.data, file.contentType);
    } catch {
      return err(ErrorCode.COMMENT_AUDIO_STORAGE_UNAVAILABLE);
    }

    const [updated] = await tx
      .update(chapter_comments)
      .set({ audioStorageKey: key, updatedAt: new Date() })
      .where(eq(chapter_comments.id, placeholder.id))
      .returning();

    if (!updated) {
      await deleteVerseAudio(key).catch(() => undefined);
      return err(ErrorCode.INTERNAL_ERROR);
    }
    return ok(await mapCommentRow(updated, [], user.id, roleDisplay));
  });
}
