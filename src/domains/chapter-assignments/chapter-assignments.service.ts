import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterAssignmentWithAuthContext } from './chapter-assignments.repository';
import type {
  ChapterAssignmentProgressInfo,
  ChapterAssignmentRecord,
  ChapterAssignmentResponse,
  ChapterAssignmentStatus,
  CreateChapterAssignmentRequestData,
  UpdateChapterAssignmentRequestData,
} from './chapter-assignments.types';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

export function toChapterAssignmentResponse(
  record: ChapterAssignmentRecord
): ChapterAssignmentResponse {
  return {
    id: record.id,
    projectUnitId: record.projectUnitId,
    bibleId: record.bibleId,
    bookId: record.bookId,
    chapterNumber: record.chapterNumber,
    assignedUserId: record.assignedUserId,
    peerCheckerId: record.peerCheckerId,
    status: record.status,
    submittedTime: record.submittedTime,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function getChapterAssignment(id: number) {
  return repo.findByIdWithOrg(id);
}

// Fetch a chapter assignment with auth context for middleware policy evaluation.
export function getChapterAssignmentWithAuthContext(
  id: number,
  userId: number,
  roleName: string
): Promise<Result<ChapterAssignmentWithAuthContext>> {
  return repo.findByIdWithAuthContext(id, userId, roleName);
}

export function getAssignmentsProgress(
  filters: {
    projectId?: number;
    assignedUserId?: number;
    peerCheckerId?: number;
    status?: ChapterAssignmentStatus;
  },
  tx?: DbTransaction
): Promise<Result<ChapterAssignmentProgressInfo[]>> {
  return repo.findAssignmentsProgress(filters, tx);
}

export function getAssignmentForVerse(projectUnitId: number, bibleTextId: number) {
  return repo.findForVerse(projectUnitId, bibleTextId);
}

export async function createChapterAssignment(data: CreateChapterAssignmentRequestData) {
  return db.transaction(async (tx) => {
    try {
      const assignment = await repo.insert(data, tx);

      await repo.insertStatusHistory(tx, assignment.id, CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED);

      if (assignment.assignedUserId) {
        await repo.insertUserAssignmentHistory(
          tx,
          assignment.id,
          assignment.assignedUserId,
          'drafter',
          CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED
        );
      }
      if (assignment.peerCheckerId) {
        await repo.insertUserAssignmentHistory(
          tx,
          assignment.id,
          assignment.peerCheckerId,
          'peer_checker',
          CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED
        );
      }

      return ok(toChapterAssignmentResponse(assignment));
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to create chapter assignment',
        context: { data },
      });
      return err(ErrorCode.INTERNAL_ERROR);
    }
  });
}

/**
 * Bulk-create chapter assignments for a project unit from bible texts.
 * Internal cross-domain function called during project-unit setup —
 * returns raw records since this is never sent directly to a client.
 */
export async function createChapterAssignmentForProjectUnit(
  projectUnitId: number,
  bibleId: number,
  bookIds: number[],
  tx: DbTransaction
) {
  try {
    const chapters = await repo.findChaptersForProjectUnit(bibleId, bookIds, tx);
    if (chapters.length === 0) return ok([]);

    const records = chapters.map((c) => ({
      projectUnitId,
      bibleId: c.bibleId,
      bookId: c.bookId,
      chapterNumber: c.chapterNumber,
      assignedUserId: null as null,
      peerCheckerId: null as null,
    }));

    const inserted = await repo.insertMany(records, tx);
    return ok(inserted);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create chapter assignments for project unit',
      context: { projectUnitId, bibleId, bookIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateChapterAssignment(
  id: number,
  data: UpdateChapterAssignmentRequestData,
  externalTx?: DbTransaction
) {
  const exec = async (tx: DbTransaction) => {
    try {
      const current = await repo.findById(id, tx);
      if (!current) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

      const finalData = applyAutoTransition(current, data);
      const updated = await repo.update(id, finalData, tx);
      if (!updated) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

      await recordStatusChange(tx, current, updated);
      await recordUserAssignmentChanges(tx, current, updated, data);

      return ok(toChapterAssignmentResponse(updated));
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to update chapter assignment',
        context: { chapterAssignmentId: id, data },
      });
      return err(ErrorCode.INTERNAL_ERROR);
    }
  };

  return externalTx ? exec(externalTx) : db.transaction(exec);
}

export async function submitChapterAssignment(chapterAssignmentId: number) {
  return db.transaction(async (tx) => {
    try {
      const current = await repo.findById(chapterAssignmentId, tx);
      if (!current) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

      let nextStatus: ChapterAssignmentStatus;
      let snapshotUser: number | null;

      switch (current.status) {
        case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK;
          snapshotUser = current.assignedUserId;
          break;
        case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW;
          snapshotUser = current.peerCheckerId;
          break;
        case CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.LINGUIST_CHECK;
          snapshotUser = current.assignedUserId;
          break;
        case CHAPTER_ASSIGNMENT_STATUS.LINGUIST_CHECK:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.THEOLOGICAL_CHECK;
          snapshotUser = current.assignedUserId;
          break;
        case CHAPTER_ASSIGNMENT_STATUS.THEOLOGICAL_CHECK:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.CONSULTANT_CHECK;
          snapshotUser = current.assignedUserId;
          break;
        case CHAPTER_ASSIGNMENT_STATUS.CONSULTANT_CHECK:
          nextStatus = CHAPTER_ASSIGNMENT_STATUS.COMPLETE;
          snapshotUser = current.assignedUserId;
          break;
        default:
          return err(ErrorCode.INVALID_STATUS_TRANSITION);
      }

      const contentResult = await repo.getContent(tx, current);
      if (!contentResult.ok) return contentResult;

      await repo.insertSnapshot(tx, {
        chapterAssignmentId,
        status: current.status,
        assignedUserId: snapshotUser,
        content: contentResult.data,
      });

      return updateChapterAssignment(
        chapterAssignmentId,
        { submittedTime: new Date(), status: nextStatus },
        tx
      );
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to submit chapter assignment',
        context: { chapterAssignmentId },
      });
      return err(ErrorCode.INTERNAL_ERROR);
    }
  });
}

export function deleteChapterAssignment(id: number) {
  return repo.remove(id);
}

function applyAutoTransition(
  current: ChapterAssignmentRecord,
  data: UpdateChapterAssignmentRequestData
): UpdateChapterAssignmentRequestData {
  const hasUserAssignment = data.assignedUserId !== undefined || data.peerCheckerId !== undefined;
  const shouldAutoTransitionToDraft =
    current.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED && hasUserAssignment && !data.status;

  return {
    ...data,
    ...(shouldAutoTransitionToDraft && { status: CHAPTER_ASSIGNMENT_STATUS.DRAFT }),
  };
}

async function recordStatusChange(
  tx: DbTransaction,
  current: ChapterAssignmentRecord,
  updated: ChapterAssignmentRecord
) {
  if (updated.status !== current.status) {
    await repo.insertStatusHistory(tx, updated.id, updated.status as ChapterAssignmentStatus);
  }
}

async function recordUserAssignmentChanges(
  tx: DbTransaction,
  current: ChapterAssignmentRecord,
  updated: ChapterAssignmentRecord,
  data: UpdateChapterAssignmentRequestData
) {
  if (
    data.assignedUserId !== undefined &&
    data.assignedUserId !== current.assignedUserId &&
    updated.assignedUserId
  ) {
    await repo.insertUserAssignmentHistory(
      tx,
      updated.id,
      updated.assignedUserId,
      'drafter',
      updated.status as ChapterAssignmentStatus
    );
  }

  if (
    data.peerCheckerId !== undefined &&
    data.peerCheckerId !== current.peerCheckerId &&
    updated.peerCheckerId
  ) {
    await repo.insertUserAssignmentHistory(
      tx,
      updated.id,
      updated.peerCheckerId,
      'peer_checker',
      updated.status as ChapterAssignmentStatus
    );
  }
}
