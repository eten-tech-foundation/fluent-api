import type { ChapterAssignmentProgressInfo } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { Result } from '@/lib/types';

import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  UserChapterAssignmentResponse,
  UserChapterAssignmentsByUserResponse,
} from './users-chapter-assignments.types';

export function toResponse(
  assignment: ChapterAssignmentProgressInfo
): UserChapterAssignmentResponse {
  return {
    chapterAssignmentId: assignment.assignmentId,
    projectId: assignment.projectId,
    projectName: assignment.projectName,
    projectUnitId: assignment.projectUnitId,
    bibleId: assignment.bibleId,
    bibleName: assignment.bibleName ?? '',
    chapterStatus: assignment.status,
    targetLanguage: assignment.targetLanguage ?? '',
    sourceLangCode: assignment.sourceLangCode ?? '',
    bookCode: assignment.bookCode,
    bookId: assignment.bookId,
    book: assignment.bookNameEng,
    chapterNumber: assignment.chapterNumber,
    totalVerses: assignment.totalVerses,
    completedVerses: assignment.completedVerses,
    submittedTime: assignment.submittedTime?.toISOString() ?? null,
    assignedUserId: assignment.assignedUserId,
    peerCheckerId: assignment.peerCheckerId,
    updatedAt: assignment.updatedAt?.toISOString() ?? null,
  };
}

export async function getAssignedChaptersByUserId(
  userId: number
): Promise<Result<UserChapterAssignmentResponse[]>> {
  const result = await chapterAssignmentService.getAssignmentsProgress({ assignedUserId: userId });
  if (!result.ok) return result;
  return ok(result.data.map(toResponse));
}

export async function getPeerCheckChaptersByUserId(
  userId: number
): Promise<Result<UserChapterAssignmentResponse[]>> {
  const result = await chapterAssignmentService.getAssignmentsProgress({
    peerCheckerId: userId,
    status: 'peer_check',
  });
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
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch all chapter assignments by user ID',
      context: { userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
