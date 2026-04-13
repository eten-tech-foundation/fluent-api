import type { ChapterAssignmentStatus } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { Result } from '@/lib/types';

import { db } from '@/db';
import {
  chapter_assignment_assigned_user_history,
  chapter_assignment_status_history,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  UserChapterAssignment,
  UserChapterAssignmentResponse,
  UserChapterAssignmentsByUserResponse,
} from './users-chapter-assignments.types';

import * as repo from './users-chapter-assignments.repository';

export function toResponse(assignment: UserChapterAssignment): UserChapterAssignmentResponse {
  return {
    chapterAssignmentId: assignment.chapterAssignmentId,
    projectId: assignment.projectId,
    projectName: assignment.projectName,
    projectUnitId: assignment.projectUnitId,
    bibleId: assignment.bibleId,
    bibleName: assignment.bibleName,
    chapterStatus: assignment.chapterStatus,
    targetLanguage: assignment.targetLanguage,
    sourceLangCode: assignment.sourceLangCode,
    bookCode: assignment.bookCode,
    bookId: assignment.bookId,
    book: assignment.book,
    chapterNumber: assignment.chapterNumber,
    totalVerses: assignment.totalVerses,
    completedVerses: assignment.completedVerses,
    submittedTime: assignment.submittedTime,
    assignedUserId: assignment.assignedUserId,
    peerCheckerId: assignment.peerCheckerId,
    updatedAt: assignment.updatedAt,
  };
}

export async function getAssignedChaptersByUserId(
  userId: number
): Promise<Result<UserChapterAssignmentResponse[]>> {
  const result = await repo.findAssignedByUserId(userId);
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}

export async function getPeerCheckChaptersByUserId(
  userId: number
): Promise<Result<UserChapterAssignmentResponse[]>> {
  const result = await repo.findPeerCheckByUserId(userId);
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}

export async function getAllChapterAssignmentsByUserId(
  userId: number
): Promise<Result<UserChapterAssignmentsByUserResponse>> {
  try {
    const [assignedResult, peerCheckResult] = await Promise.all([
      getAssignedChaptersByUserId(userId),
      getPeerCheckChaptersByUserId(userId),
    ]);

    if (!assignedResult.ok) return assignedResult;
    if (!peerCheckResult.ok) return peerCheckResult;

    return ok({
      assignedChapters: assignedResult.data,
      peerCheckChapters: peerCheckResult.data,
    });
  } catch (e) {
    logger.error({
      cause: e,
      message: 'Failed to fetch all chapter assignments by user ID',
      context: { userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
export async function assignUserToChapters(
  assignedUserId: number | null,
  chapterAssignmentIds: number[],
  peerCheckerId: number | null
): Promise<Result<number[]>> {
  if (chapterAssignmentIds.length === 0) return ok([]);

  if (chapterAssignmentIds.length > repo.MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST) {
    return err(ErrorCode.CHAPTER_LIMIT_EXCEEDED);
  }

  try {
    return await db.transaction(async (tx) => {
      const currentAssignments = await repo.findCurrentAssignments(chapterAssignmentIds, tx);

      const projectUnitIds = [...new Set(currentAssignments.map((a) => a.projectUnitId))];
      if (projectUnitIds.length > 0) {
        const projectIdsToActivate = await repo.findNotAssignedProjectIds(projectUnitIds, tx);
        await repo.activateProjects(projectIdsToActivate, tx);
      }

      const updated = await repo.bulkUpdateAssignments(
        chapterAssignmentIds,
        assignedUserId, // passes null through to repo
        peerCheckerId, // passes null through to repo
        tx
      );

      const assignedUserHistoryRecords = [];
      const statusHistoryRecords = [];

      for (const updatedAssignment of updated) {
        const current = currentAssignments.find((a) => a.id === updatedAssignment.id);
        if (!current) continue;

        // Only record drafter history if assignedUserId is non-null and changed
        if (assignedUserId !== null && current.assignedUserId !== assignedUserId) {
          assignedUserHistoryRecords.push({
            chapterAssignmentId: updatedAssignment.id,
            assignedUserId,
            role: 'drafter' as const,
            status: updatedAssignment.status as ChapterAssignmentStatus,
          });
        }

        // Only record peer checker history if peerCheckerId is non-null and changed
        if (peerCheckerId !== null && current.peerCheckerId !== peerCheckerId) {
          assignedUserHistoryRecords.push({
            chapterAssignmentId: updatedAssignment.id,
            assignedUserId: peerCheckerId,
            role: 'peer_checker' as const,
            status: updatedAssignment.status as ChapterAssignmentStatus,
          });
        }

        if (current.status !== updatedAssignment.status) {
          statusHistoryRecords.push({
            chapterAssignmentId: updatedAssignment.id,
            status: updatedAssignment.status as ChapterAssignmentStatus,
          });
        }
      }

      if (assignedUserHistoryRecords.length > 0) {
        await tx
          .insert(chapter_assignment_assigned_user_history)
          .values(assignedUserHistoryRecords);
      }

      if (statusHistoryRecords.length > 0) {
        await tx.insert(chapter_assignment_status_history).values(statusHistoryRecords);
      }

      return ok(updated.map((a) => a.id));
    });
  } catch (e) {
    logger.error({
      cause: e,
      message: 'Failed to assign users to chapters',
      context: { assignedUserId, chapterAssignmentIds, peerCheckerId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
