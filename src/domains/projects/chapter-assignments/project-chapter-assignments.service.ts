import type {
  ChapterAssignmentProgressInfo,
  ChapterAssignmentStatus,
} from '@/domains/chapter-assignments/chapter-assignments.types';
import type { Result } from '@/lib/types';

import { db } from '@/db';
import { runInTransaction } from '@/db/transaction';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import * as projectsService from '@/domains/projects/projects.service';
import { lockProject } from '@/domains/projects/workflow-stages/workflow-stages.service';
import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AssignSelectedItem,
  AssignUserInput,
  ChapterAssignmentProgress,
  ChapterAssignmentWithProjectId,
  ResetSelectedRequest,
} from './project-chapter-assignments.types';

import * as projectRepo from '../projects.repository';
import * as repo from './project-chapter-assignments.repository';

export async function getProjectChapterAssignments(projectId: number, milestoneId?: number) {
  const result = await repo.getByProject(projectId, milestoneId);
  if (!result.ok) return result;
  return ok(await chapterAssignmentService.buildChapterAssignmentResponses(result.data));
}

export function deleteChapterAssignmentsByProject(projectId: number) {
  return repo.deleteByProject(projectId);
}

/**
 * Map a repository `ChapterAssignmentProgressInfo` row to the wire-shape
 * `ChapterAssignmentProgress` response. Shared by the project-progress and
 * assign-selected endpoints so the field mapping (incl. `targetLangCode`) lives
 * in exactly one place.
 */
function toChapterAssignmentProgressResponse(info: ChapterAssignmentProgressInfo) {
  return {
    assignmentId: info.assignmentId,
    projectUnitId: info.projectUnitId,
    status: info.status,
    bookNameEng: info.bookNameEng,
    chapterNumber: info.chapterNumber,
    bibleId: info.bibleId,
    ttsLicenseStatus: info.ttsLicenseStatus,
    textBibleKey: info.textBibleKey,
    selectedRecordingKey: info.selectedRecordingKey,
    bookId: info.bookId,
    bookCode: info.bookCode,
    sourceLangCode: info.sourceLangCode ?? '',
    targetLangCode: info.targetLangCode ?? '',
    assignedUser: info.assignedUserId
      ? { id: info.assignedUserId, displayName: info.assignedUserDisplayName ?? '' }
      : null,
    peerChecker: info.peerCheckerId
      ? { id: info.peerCheckerId, displayName: info.peerCheckerDisplayName ?? '' }
      : null,
    totalVerses: info.totalVerses,
    completedVerses: info.completedVerses,
    createdAt: info.createdAt,
    updatedAt: info.updatedAt,
    submittedTime: info.submittedTime,
    stageEnteredAt: info.stageEnteredAt,
    isAiEnabled: info.isAiEnabled,
    hasConflict: info.hasConflict,
  };
}

export async function getChapterAssignmentProgressByProject(projectId: number) {
  const result = await chapterAssignmentService.getAssignmentsProgress({ projectId });
  if (!result.ok) return result;

  const mapped = result.data.map(toChapterAssignmentProgressResponse);
  return ok(mapped);
}

export async function assignAllProjectChapterAssignmentsToUser(
  projectId: number,
  assignmentData: AssignUserInput
) {
  return db.transaction(async (tx) => {
    const projectResult = await projectsService.getProjectById(projectId);
    if (!projectResult.ok) return err(ErrorCode.PROJECT_NOT_FOUND);
    const projectOrgId = projectResult.data.organization;

    if (assignmentData.assignedUserId !== undefined || assignmentData.peerCheckerId !== undefined) {
      const userIds = [assignmentData.assignedUserId, assignmentData.peerCheckerId].filter(
        (id): id is number => id !== undefined
      );

      const validUserIds = await findUserIdsInOrg(projectOrgId, userIds);
      const invalidUsers = userIds.some((id) => !validUserIds.has(id));
      if (invalidUsers) return err(ErrorCode.USER_NOT_IN_ORGANIZATION);
    }

    const assignmentIds = await repo.getAssignmentIdsByProject(projectId, tx);
    if (assignmentIds.length === 0) return ok([]);

    const updatedAssignments = [];
    for (const id of assignmentIds) {
      const result = await chapterAssignmentService.updateChapterAssignment(id, assignmentData, tx);
      if (!result.ok) return result;
      updatedAssignments.push(result.data);
    }

    return ok(updatedAssignments);
  });
}

export async function assignSelectedChapters(
  projectId: number,
  assignments: AssignSelectedItem[]
): Promise<Result<ChapterAssignmentProgress[]>> {
  if (assignments.length === 0) return ok([]);

  if (assignments.length > repo.MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST) {
    return err(ErrorCode.CHAPTER_LIMIT_EXCEEDED);
  }

  try {
    return await db.transaction(async (tx) => {
      const chapterAssignmentIds = assignments.map((a) => a.chapterAssignmentId);
      const invalidAssignmentIds = await projectRepo.findAssignmentIdsNotInProject(
        projectId,
        chapterAssignmentIds,
        tx
      );
      if (invalidAssignmentIds.length > 0) {
        logger.warn('Invalid chapter assignment IDs requested for project', {
          projectId,
          invalidAssignmentIds,
        });
        return err(ErrorCode.NOT_FOUND);
      }

      const allUserIds = [
        ...new Set(
          assignments.flatMap((a) =>
            [a.drafterId, a.peerCheckerId].filter((id): id is number => id !== null)
          )
        ),
      ];
      if (allUserIds.length > 0) {
        const projectResult = await projectsService.getProjectById(projectId);
        if (!projectResult.ok) return err(ErrorCode.PROJECT_NOT_FOUND);
        const projectOrgId = projectResult.data.organization;

        const validUserIds = await findUserIdsInOrg(projectOrgId, allUserIds);

        const invalidUserIds = allUserIds.filter((id) => !validUserIds.has(id));

        if (invalidUserIds.length > 0) {
          logger.warn('Users not found in project organization', { projectId, invalidUserIds });
          return err(ErrorCode.NOT_FOUND);
        }
      }

      const projectUnitIds = await repo.findProjectUnitIdsByAssignmentIds(chapterAssignmentIds, tx);
      if (projectUnitIds.length > 0) {
        const projectIdsToActivate = await repo.findNotAssignedProjectIds(projectUnitIds, tx);
        await repo.activateProjects(projectIdsToActivate, tx);
      }

      const updatedIds: number[] = [];
      for (const item of assignments) {
        const result = await chapterAssignmentService.updateChapterAssignment(
          item.chapterAssignmentId,
          { assignedUserId: item.drafterId, peerCheckerId: item.peerCheckerId },
          tx
        );
        if (!result.ok) return result;
        updatedIds.push(item.chapterAssignmentId);
      }

      const assignmentsResult = await chapterAssignmentService.getAssignmentsProgress(
        { projectId },
        tx
      );
      if (!assignmentsResult.ok) return err(ErrorCode.INTERNAL_ERROR);

      const mapped = assignmentsResult.data
        .filter((info) => updatedIds.includes(info.assignmentId))
        .map(toChapterAssignmentProgressResponse);

      return ok(mapped);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to assign selected chapters',
      context: { projectId, assignments },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

const RESETTABLE_STATUSES = new Set<ChapterAssignmentStatus>([
  CHAPTER_ASSIGNMENT_STATUS.DRAFT,
  CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
]);

export async function resetSelectedChapters(
  projectId: number,
  chapterAssignmentIds: ResetSelectedRequest['chapterAssignmentIds']
): Promise<Result<ChapterAssignmentProgress[]>> {
  if (chapterAssignmentIds.length > repo.MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST) {
    return err(ErrorCode.CHAPTER_LIMIT_EXCEEDED);
  }

  try {
    return await runInTransaction(async (tx) => {
      // Match submitChapterAssignment lock order (project, then assignments) to avoid 40P01.
      const lockResult = await lockProject(tx, projectId);
      if (!lockResult.ok) return lockResult;

      const invalidAssignmentIds = await projectRepo.findAssignmentIdsNotInProject(
        projectId,
        chapterAssignmentIds,
        tx
      );
      if (invalidAssignmentIds.length > 0) {
        logger.warn('Invalid chapter assignment IDs requested for project', {
          projectId,
          invalidAssignmentIds,
        });
        return err(ErrorCode.NOT_FOUND);
      }

      const statusRows = await repo.findStatusesByIds(chapterAssignmentIds, tx);
      const statusById = new Map(statusRows.map((row) => [row.id, row.status]));
      const missingIds = chapterAssignmentIds.filter((id) => !statusById.has(id));
      if (missingIds.length > 0) {
        logger.warn('Chapter assignment IDs missing after project membership check', {
          projectId,
          missingIds,
        });
        return err(ErrorCode.NOT_FOUND);
      }

      const notResettable = chapterAssignmentIds.filter((id) => {
        const status = statusById.get(id);
        return status === undefined || !RESETTABLE_STATUSES.has(status);
      });
      if (notResettable.length > 0) {
        logger.warn('Chapter assignments are not resettable from their current status', {
          projectId,
          chapterAssignmentIds: notResettable,
          statuses: notResettable.map((id) => ({ id, status: statusById.get(id) })),
        });
        return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_RESETTABLE);
      }

      const updatedIds: number[] = [];
      // Sequential: each updateChapterAssignment shares this tx (and its project lock).
      for (const id of chapterAssignmentIds) {
        const result = await chapterAssignmentService.updateChapterAssignment(
          id,
          {
            status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
            assignedUserId: null,
            peerCheckerId: null,
            submittedTime: null,
          },
          tx
        );
        if (!result.ok) return result;
        updatedIds.push(id);
      }

      const assignmentsResult = await chapterAssignmentService.getAssignmentsProgress(
        { projectId },
        tx
      );
      if (!assignmentsResult.ok) return err(ErrorCode.INTERNAL_ERROR);

      const mapped = assignmentsResult.data
        .filter((info) => updatedIds.includes(info.assignmentId))
        .map(toChapterAssignmentProgressResponse);

      return ok(mapped);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to reset selected chapters',
      context: { projectId, chapterAssignmentIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

function toMemberChapterAssignmentResponse(
  record: ChapterAssignmentWithProjectId,
  stageEnteredAt: string | null
) {
  return {
    chapterAssignmentId: record.id,
    projectId: record.projectId,
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
    stageEnteredAt,
    hasClaimConflict: record.hasClaimConflict,
    claimConflictUserId: record.claimConflictUserId,
  };
}

export async function getChapterAssignmentsByUserId(
  userId: number,
  excludeProjectIds: number[] = [],
  updatedAfter?: Date,
  orgId?: number
) {
  const projectsResult = await userProjectsService.getProjectsByUserId(userId, orgId);
  if (!projectsResult.ok) return projectsResult;

  const projectIds = projectsResult.data
    .map((p) => p.id)
    .filter((id) => !excludeProjectIds.includes(id));

  if (projectIds.length === 0) return ok([]);

  const result = await repo.getByProjects(projectIds, excludeProjectIds, updatedAfter);
  if (!result.ok) return result;

  const stageEnteredAtById = await chapterAssignmentService.getStageEnteredAtByAssignmentIds(
    result.data.map((record) => ({ id: record.id, status: record.status }))
  );

  return ok(
    result.data.map((record) =>
      toMemberChapterAssignmentResponse(record, stageEnteredAtById.get(record.id) ?? null)
    )
  );
}
