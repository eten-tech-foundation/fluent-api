import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import * as aiSuggestionsService from '@/domains/ai-suggestions/ai-suggestions.service';
import * as projectsService from '@/domains/projects/projects.service';
import {
  lockProject,
  readStagesSeeded,
} from '@/domains/projects/workflow-stages/workflow-stages.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterAssignmentWithAuthContext } from './chapter-assignments.repository';
import type {
  ChapterAssignmentRecord,
  ChapterAssignmentResponse,
  ChapterAssignmentStatus,
  CreateChapterAssignmentRequestData,
  UpdateChapterAssignmentRequestData,
} from './chapter-assignments.types';

import * as repo from './chapter-assignments.repository';
import {
  applyAutoTransition,
  recordStatusChange,
  recordUserAssignmentChanges,
} from './chapter-assignments.transitions';
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
    hasClaimConflict: record.hasClaimConflict,
    claimConflictUserId: record.claimConflictUserId,
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
  userId: number
): Promise<Result<ChapterAssignmentWithAuthContext>> {
  return repo.findByIdWithAuthContext(id, userId);
}

export { getAssignmentsProgress } from './progress/chapter-assignments-progress.service';

export function getAssignmentForVerse(projectUnitId: number, bibleTextId: number) {
  return repo.findForVerse(projectUnitId, bibleTextId);
}

export async function createChapterAssignment(data: CreateChapterAssignmentRequestData) {
  const result = await db.transaction(async (tx) => {
    try {
      const assignment = await repo.insert(data, tx);

      await repo.insertStatusHistory(tx, assignment.id, CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED);

      let shouldTriggerAi = false;
      if (assignment.assignedUserId) {
        await repo.insertUserAssignmentHistory(
          tx,
          assignment.id,
          assignment.assignedUserId,
          'drafter',
          CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED
        );
        shouldTriggerAi = true;
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

      return ok({
        response: toChapterAssignmentResponse(assignment),
        shouldTriggerAi,
      });
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to create chapter assignment',
        context: { data },
      });
      return err(ErrorCode.INTERNAL_ERROR);
    }
  });

  if (!result.ok) {
    return result;
  }

  if (result.data.shouldTriggerAi) {
    const assignment = result.data.response;
    try {
      await aiSuggestionsService.handleChapterAssigned(
        assignment.projectUnitId,
        assignment.bibleId,
        assignment.bookId,
        assignment.chapterNumber
      );
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to enqueue AI suggestions after chapter assignment',
        context: {
          projectUnitId: assignment.projectUnitId,
          bibleId: assignment.bibleId,
          bookId: assignment.bookId,
          chapterNumber: assignment.chapterNumber,
        },
      });
    }
  }

  return ok(result.data.response);
}

/**
 * Bulk-create chapter assignments for a project unit from bible texts.
 * Internal cross-domain function called during project-unit setup —
 * returns raw records since this is never sent directly to a client.
 */
async function createChapterAssignmentForProjectUnitInTransaction(
  projectUnitId: number,
  bibleId: number,
  bookIds: number[],
  tx: DbTransaction
): Promise<ChapterAssignmentRecord[]> {
  const chapters = await repo.findChaptersForProjectUnit(bibleId, bookIds, tx);
  if (chapters.length === 0) return [];

  const records = chapters.map((c) => ({
    projectUnitId,
    bibleId: c.bibleId,
    bookId: c.bookId,
    chapterNumber: c.chapterNumber,
    assignedUserId: null,
    peerCheckerId: null,
  }));

  const inserted = await repo.insertMany(records, tx);
  if (inserted.length > 0) {
    const historyRecords = inserted.map((a) => ({
      chapterAssignmentId: a.id,
      status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
    }));
    await repo.insertManyStatusHistory(tx, historyRecords);
  }

  return inserted;
}

export async function createChapterAssignmentForProjectUnit(
  projectUnitId: number,
  bibleId: number,
  bookIds: number[],
  tx?: DbTransaction
) {
  try {
    const inserted = tx
      ? await createChapterAssignmentForProjectUnitInTransaction(
          projectUnitId,
          bibleId,
          bookIds,
          tx
        )
      : await db.transaction((transaction) =>
          createChapterAssignmentForProjectUnitInTransaction(
            projectUnitId,
            bibleId,
            bookIds,
            transaction
          )
        );

    return ok(inserted);
  } catch (error) {
    logger.error({
      cause: error,
      message: `Failed to create chapter assignments for project unit: ${error instanceof Error ? error.message : String(error)}`,
      stack: error instanceof Error ? error.stack : undefined,
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
    const current = await repo.findById(id, tx);
    if (!current) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

    const finalData = applyAutoTransition(current, data);
    const updateData =
      data.assignedUserId !== undefined
        ? { ...finalData, hasClaimConflict: false, claimConflictUserId: null }
        : finalData;
    const updated = await repo.update(id, updateData, tx);
    if (!updated) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

    await recordStatusChange(tx, current, updated);
    const shouldTriggerAi = await recordUserAssignmentChanges(tx, current, updated, data);

    await projectsService.touchProjectActivity(updated.projectUnitId, tx);

    return ok({
      response: toChapterAssignmentResponse(updated),
      shouldTriggerAi,
    });
  };

  let result;
  if (externalTx) {
    result = await exec(externalTx);
  } else {
    try {
      result = await db.transaction(exec);
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to update chapter assignment',
        context: { chapterAssignmentId: id, data },
      });
      return err(ErrorCode.INTERNAL_ERROR);
    }
  }

  if (!result.ok) {
    return result;
  }

  if (result.data.shouldTriggerAi) {
    const assignment = result.data.response;
    try {
      await aiSuggestionsService.handleChapterAssigned(
        assignment.projectUnitId,
        assignment.bibleId,
        assignment.bookId,
        assignment.chapterNumber
      );
    } catch (error) {
      logger.error({
        cause: error,
        message: 'Failed to enqueue AI suggestions after updating user assignment',
        context: {
          projectUnitId: assignment.projectUnitId,
          bibleId: assignment.bibleId,
          bookId: assignment.bookId,
          chapterNumber: assignment.chapterNumber,
        },
      });
    }
  }

  return ok(result.data.response);
}

export async function submitChapterAssignment(chapterAssignmentId: number, userId: number) {
  const exec = async (tx: DbTransaction) => {
    const initial = await repo.findById(chapterAssignmentId, tx);
    if (!initial) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

    const projectId = await repo.findProjectIdByUnitId(initial.projectUnitId, tx);
    if (!projectId) return err(ErrorCode.INTERNAL_ERROR);

    const lockResult = await lockProject(tx, projectId);
    if (!lockResult.ok) return lockResult;

    // Refresh assignment after lock to avoid stale status under concurrency.
    const current = await repo.findById(chapterAssignmentId, tx);
    if (!current) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

    const stages = await readStagesSeeded(tx, projectId);

    const currentIndex = stages.findIndex((s) => s.defaultName === current.status);
    if (currentIndex === -1 || currentIndex >= stages.length - 1) {
      return err(ErrorCode.INVALID_STATUS_TRANSITION);
    }

    const nextStatus = stages[currentIndex + 1].defaultName as ChapterAssignmentStatus;

    // Determine the snapshot user (who submitted it).
    // For peer check, it's the peer checker. For everything else, it's the assigned drafter.
    let snapshotUser = current.assignedUserId;
    if (current.status === CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK) {
      snapshotUser = current.peerCheckerId ?? userId;
    }

    const contentResult = await repo.getContent(tx, current);
    if (!contentResult.ok) return contentResult;

    if (current.status === CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK) {
      const submittedTime = new Date();
      const updated = await repo.submitPeerCheckIfEligible(
        chapterAssignmentId,
        userId,
        nextStatus,
        submittedTime,
        tx
      );
      if (!updated) {
        const latest = await repo.findById(chapterAssignmentId, tx);
        if (!latest) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
        return ok(toChapterAssignmentResponse(latest));
      }

      await repo.insertSnapshot(tx, {
        chapterAssignmentId,
        status: current.status,
        assignedUserId: snapshotUser,
        content: contentResult.data,
      });
      await recordStatusChange(tx, current, updated);
      await recordUserAssignmentChanges(tx, current, updated, {
        peerCheckerId: updated.peerCheckerId,
        status: nextStatus,
        submittedTime,
      });
      await projectsService.touchProjectActivity(updated.projectUnitId, tx);
      return ok(toChapterAssignmentResponse(updated));
    }

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
  };

  try {
    return await db.transaction(exec);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to submit chapter assignment',
      context: { chapterAssignmentId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export function deleteChapterAssignment(id: number) {
  return repo.remove(id);
}

export async function claimChapterAssignment(id: number, userId: number) {
  try {
    const result = await db.transaction(async (tx) => {
      const { claimed, record } = await repo.claimIfUnassigned(id, userId, tx);

      if (claimed && record) {
        await repo.insertStatusHistory(tx, id, CHAPTER_ASSIGNMENT_STATUS.DRAFT);
        await repo.insertUserAssignmentHistory(
          tx,
          id,
          userId,
          'drafter',
          CHAPTER_ASSIGNMENT_STATUS.DRAFT
        );
        await projectsService.recordProjectAssignmentActivity(record.projectUnitId, tx);
        return ok({
          response: toChapterAssignmentResponse(record),
          shouldTriggerAi: true,
        });
      }

      const current = await repo.findById(id, tx);
      if (!current) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

      if (current.assignedUserId === userId) {
        return ok({
          response: toChapterAssignmentResponse(current),
          shouldTriggerAi: false,
        });
      }

      const flagged = await repo.flagClaimConflict(id, userId, tx);
      return ok({
        response: toChapterAssignmentResponse(flagged ?? current),
        shouldTriggerAi: false,
      });
    });

    if (!result.ok) {
      return result;
    }

    if (result.data.shouldTriggerAi) {
      const assignment = result.data.response;
      try {
        await aiSuggestionsService.handleChapterAssigned(
          assignment.projectUnitId,
          assignment.bibleId,
          assignment.bookId,
          assignment.chapterNumber
        );
      } catch (error) {
        logger.error({
          cause: error,
          message: 'Failed to enqueue AI suggestions after chapter claim',
          context: {
            projectUnitId: assignment.projectUnitId,
            bibleId: assignment.bibleId,
            bookId: assignment.bookId,
            chapterNumber: assignment.chapterNumber,
          },
        });
      }
    }

    return ok(result.data.response);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to claim chapter assignment',
      context: { id, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateChapterAssignmentAiStatus(
  assignmentId: number,
  isAiEnabled: boolean
): Promise<Result<void>> {
  try {
    let assignmentProjectUnitId = 0;
    let assignmentBibleId = 0;
    let assignmentBookId = 0;
    let assignmentChapterNumber = 0;

    await db.transaction(async (tx) => {
      const assignment = await repo.findById(assignmentId, tx);
      if (!assignment) {
        throw new Error(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
      }

      assignmentProjectUnitId = assignment.projectUnitId;
      assignmentBibleId = assignment.bibleId;
      assignmentBookId = assignment.bookId;
      assignmentChapterNumber = assignment.chapterNumber;

      if (assignment.isAiEnabled === isAiEnabled) {
        return;
      }
      await repo.update(assignmentId, { isAiEnabled }, tx);
    });

    if (isAiEnabled) {
      try {
        // Runs after the isAiEnabled update has committed (not inside a transaction);
        // catch errors so a failed AI trigger doesn't affect the already-saved status.
        await aiSuggestionsService.handleChapterAssigned(
          assignmentProjectUnitId,
          assignmentBibleId,
          assignmentBookId,
          assignmentChapterNumber
        );
      } catch (error) {
        logger.error({
          cause: error,
          message: 'Failed to enqueue AI suggestions after toggling AI status',
          context: {
            projectUnitId: assignmentProjectUnitId,
            bibleId: assignmentBibleId,
            bookId: assignmentBookId,
            chapterNumber: assignmentChapterNumber,
          },
        });
      }
    }

    return ok(undefined);
  } catch (error) {
    if (error instanceof Error && error.message === ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND) {
      return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    }
    logger.error({
      cause: error,
      message: 'Failed to toggle AI status for chapter assignment',
      context: { assignmentId, isAiEnabled },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
