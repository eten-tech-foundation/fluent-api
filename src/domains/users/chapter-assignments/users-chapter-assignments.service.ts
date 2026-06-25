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
  // TEMP DIAGNOSTIC (BUG: legitimate not working) — remove before PR.
  // Proves concretely what ISO code the API emits per assignment. If this logs
  // '' (empty) the project's target_language FK doesn't resolve to a lang row
  // with a non-null lang_code_iso_639_3; if it logs 'eng' the break is web-side.
  logger.info(
    {
      assignmentId: assignment.assignmentId,
      projectId: assignment.projectId,
      targetLanguage: assignment.targetLanguage,
      targetLangCode: assignment.targetLangCode,
    },
    '[RW-DIAG] toResponse targetLangCode'
  );

  return {
    chapterAssignmentId: assignment.assignmentId,
    projectId: assignment.projectId,
    projectName: assignment.projectName,
    projectUnitId: assignment.projectUnitId,
    bibleId: assignment.bibleId,
    bibleName: assignment.bibleName ?? '',
    chapterStatus: assignment.status,
    targetLanguage: assignment.targetLanguage ?? '',
    targetLanguageCode: assignment.targetLangCode ?? '',
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
