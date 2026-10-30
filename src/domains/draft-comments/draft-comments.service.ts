import type { ChapterCommentReaction } from '@/db/draft-comments.schema';
import type { AppPolicyUser, Result } from '@/lib/types';

import { runInTransaction } from '@/db/transaction';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  ChapterCommentAggregate,
  ChapterCommentResponse,
  CreateReplyRequest,
  CreateTopLevelCommentRequest,
  ListChapterCommentsResponse,
} from './draft-comments.types';

import { resolveAnchorSnapshot } from './draft-comments.anchors';
import { mapCommentRow } from './draft-comments.map';
import { DraftCommentPolicy } from './draft-comments.policy';
import * as repo from './draft-comments.repository';
import { COMMENT_BODY_KIND, COMMENT_CONNECTION_STATE } from './draft-comments.types';

export { createAudioComment } from './draft-comments.audio.service';

/** Scope lookup for route middleware (keeps routes off repositories — FA-L3). */
export async function resolveCommentAssignmentScope(chapterAssignmentId: number) {
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return null;
  return {
    orgId: assignment.organizationId,
    projectId: assignment.projectId,
  };
}

function bodyColumns(body: CreateTopLevelCommentRequest['body'] | CreateReplyRequest['body']): {
  bodyKind: 'text' | 'emoji';
  bodyText: string | null;
  emoji: string | null;
} {
  if (body.kind === COMMENT_BODY_KIND.TEXT) {
    return {
      bodyKind: 'text',
      bodyText: body.text,
      emoji: null,
    };
  }
  return {
    bodyKind: 'emoji',
    bodyText: null,
    emoji: body.emoji,
  };
}

export async function listChapterComments(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  roleDisplayByUserId: Map<number, string | null> = new Map()
): Promise<Result<ListChapterCommentsResponse>> {
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

  const rows = await repo.listCommentsForAssignment(chapterAssignmentId);
  const [reactions, roleDisplays] = await Promise.all([
    repo.listReactionsForComments(rows.map((r) => r.id)),
    roleDisplayByUserId.size > 0
      ? Promise.resolve(roleDisplayByUserId)
      : repo.findProjectRoleDisplays(assignment.projectId, [
          ...new Set(rows.map((r) => r.authorUserId)),
        ]),
  ]);
  const byComment = new Map<number, ChapterCommentReaction[]>();
  for (const reaction of reactions) {
    const list = byComment.get(reaction.commentId) ?? [];
    list.push(reaction);
    byComment.set(reaction.commentId, list);
  }

  const mapped = await Promise.all(
    rows.map((row) =>
      mapCommentRow(
        row,
        byComment.get(row.id) ?? [],
        user.id,
        roleDisplays.get(row.authorUserId) ?? null
      )
    )
  );

  const connected: ChapterCommentResponse[] = [];
  const unconnected: ChapterCommentResponse[] = [];
  for (const [index, row] of rows.entries()) {
    const item = mapped[index]!;
    if (row.connectionState === COMMENT_CONNECTION_STATE.UNCONNECTED) {
      unconnected.push(item);
    } else {
      connected.push(item);
    }
  }
  return ok({ connected, unconnected });
}

export async function getChapterCommentAggregate(
  user: AppPolicyUser,
  chapterAssignmentId: number
): Promise<Result<ChapterCommentAggregate>> {
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

  const [commentCount, currentUserHasCommented] = await Promise.all([
    repo.countCommentsForAssignment(chapterAssignmentId),
    repo.userHasAuthoredComment(chapterAssignmentId, user.id),
  ]);
  return ok({ chapterAssignmentId, commentCount, currentUserHasCommented });
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

export async function createTopLevelComment(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  input: CreateTopLevelCommentRequest,
  roleDisplay: string | null = null
): Promise<Result<ChapterCommentResponse>> {
  // Fast-fail outside the write lock (same shape as createAudioComment).
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  const denied = denyWrite(user, assignment);
  if (denied) return denied;

  const body = bodyColumns(input.body);
  const result = await runInTransaction(async (tx) => {
    // Lock assignment+project, then revalidate the anchor before insert so a
    // concurrent project pericope_set_id update cannot leave a stale connected row.
    const liveAssignment = await repo.lockAssignmentWriteContext(chapterAssignmentId, tx);
    if (!liveAssignment || liveAssignment.projectId !== assignment.projectId) {
      return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    }
    const liveDenied = denyWrite(user, liveAssignment);
    if (liveDenied) return liveDenied;

    const bibleText =
      input.anchor.kind === 'verse'
        ? await repo.lockBibleTextById(input.anchor.bibleTextId, tx)
        : null;
    const pericopeMembership =
      input.anchor.kind === 'pericope' && liveAssignment.pericopeSetId != null
        ? await repo.lockPericopeMembership(
            liveAssignment.pericopeSetId,
            liveAssignment.bookId,
            liveAssignment.chapterNumber,
            input.anchor.pericopeNumber,
            tx
          )
        : null;
    const snapshot = resolveAnchorSnapshot(
      input.anchor,
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

    const row = await repo.insertComment(
      {
        projectId: liveAssignment.projectId,
        chapterAssignmentId,
        authorUserId: user.id,
        parentCommentId: null,
        ...body,
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
    return ok(row);
  });
  if (!result.ok) return result;
  return ok(await mapCommentRow(result.data, [], user.id, roleDisplay));
}

export async function createReply(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  input: CreateReplyRequest,
  roleDisplay: string | null = null
): Promise<Result<ChapterCommentResponse>> {
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  const denied = denyWrite(user, assignment);
  if (denied) return denied;

  const target = await repo.findCommentById(input.replyToCommentId);
  if (!target || target.chapterAssignmentId !== chapterAssignmentId) {
    return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
  }

  const rootId = target.parentCommentId ?? target.id;
  const root = target.parentCommentId == null ? target : await repo.findCommentById(rootId);
  if (!root || root.chapterAssignmentId !== chapterAssignmentId) {
    return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
  }

  const body = bodyColumns(input.body);
  const row = await repo.insertComment({
    projectId: assignment.projectId,
    chapterAssignmentId,
    authorUserId: user.id,
    parentCommentId: rootId,
    ...body,
    anchorKind: root.anchorKind,
    anchorBibleId: root.anchorBibleId,
    anchorBookId: root.anchorBookId,
    anchorChapterNumber: root.anchorChapterNumber,
    anchorBibleTextId: root.anchorBibleTextId,
    anchorVerseNumber: root.anchorVerseNumber,
    anchorPericopeSetId: root.anchorPericopeSetId,
    anchorPericopeNumber: root.anchorPericopeNumber,
    anchorPericopeTitle: root.anchorPericopeTitle,
    connectionState: root.connectionState,
  });
  return ok(await mapCommentRow(row, [], user.id, roleDisplay));
}

export async function setReaction(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  commentId: number,
  emoji: string
): Promise<Result<{ emoji: string | null }>> {
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  const denied = denyWrite(user, assignment);
  if (denied) return denied;

  return runInTransaction<{ emoji: string | null }>(async (tx) => {
    const comment = await repo.findCommentById(commentId, tx);
    if (!comment || comment.chapterAssignmentId !== chapterAssignmentId) {
      return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
    }
    const active = await repo.atomicSetReaction(commentId, user.id, emoji, tx);
    return ok<{ emoji: string | null }>({ emoji: active });
  });
}

export async function clearReaction(
  user: AppPolicyUser,
  chapterAssignmentId: number,
  commentId: number
): Promise<Result<{ cleared: true }>> {
  const assignment = await repo.findAssignmentContext(chapterAssignmentId);
  if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
  const denied = denyWrite(user, assignment);
  if (denied) return denied;
  const comment = await repo.findCommentById(commentId);
  if (!comment || comment.chapterAssignmentId !== chapterAssignmentId) {
    return err(ErrorCode.CHAPTER_COMMENT_NOT_FOUND);
  }
  await repo.deleteReaction(commentId, user.id);
  return ok({ cleared: true });
}
