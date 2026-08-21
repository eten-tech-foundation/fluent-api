import type { ChapterAssignmentProgressInfo } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { Result } from '@/lib/types';

import { db } from '@/db';
import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { toChapterAssignmentResponse } from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectsService from '@/domains/projects/projects.service';
import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import * as userProjectsService from '@/domains/users/projects/user-projects.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  AssignSelectedItem,
  AssignUserInput,
  ChapterAssignmentProgress,
  ChapterAssignmentWithProjectId,
} from './project-chapter-assignments.types';

import * as projectRepo from '../projects.repository';
import * as repo from './project-chapter-assignments.repository';

export async function getProjectChapterAssignments(projectId: number) {
  const result = await repo.getByProject(projectId);
  if (!result.ok) return result;
  return ok(result.data.map(toChapterAssignmentResponse));
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
    isAiEnabled: info.isAiEnabled,
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

function toMemberChapterAssignmentResponse(record: ChapterAssignmentWithProjectId) {
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

  return ok(result.data.map(toMemberChapterAssignmentResponse));
}
