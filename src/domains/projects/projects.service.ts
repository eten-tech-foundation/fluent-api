import type { Result } from '@/lib/types';

import { db } from '@/db';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateProjectServiceInput, Project, UpdateProjectInput } from './projects.types';

import * as repo from './projects.repository';

export function getProjectsByOrganization(organizationId: number) {
  return repo.getByOrganization(organizationId);
}

export function getProjectsByUserId(userId: number) {
  return repo.getByUserId(userId);
}

export function getProjectById(id: number) {
  return repo.getById(id);
}

export function deleteProject(id: number) {
  return repo.remove(id);
}

export function getProjectIdByUnitId(projectUnitId: number) {
  return repo.getProjectIdByUnitId(projectUnitId);
}

export async function createProject(input: CreateProjectServiceInput): Promise<Result<Project>> {
  try {
    const validBookIds = await repo.getValidBookIdsForBible(input.bibleId);
    const hasInvalidBooks = input.bookId.some((id) => !validBookIds.includes(id));

    if (hasInvalidBooks) {
      logger.error({
        message: 'Invalid bible books requested',
        context: { requestedBooks: input.bookId, bibleId: input.bibleId },
      });
      return err(ErrorCode.INVALID_BIBLE_BOOKS);
    }

    return await db.transaction(async (tx) => {
      const { bibleId, bookId, projectUnitStatus = 'not_started', ...projectData } = input;

      const project = await repo.insertProjectRecord(
        { ...projectData, status: 'not_assigned' },
        tx
      );

      const projectUnit = await repo.insertProjectUnitRecord(
        { projectId: project.id, status: projectUnitStatus },
        tx
      );

      const bibleBookEntries = bookId.map((id) => ({
        projectUnitId: projectUnit.id,
        bibleId,
        bookId: id,
      }));
      await repo.insertBibleBookLinks(bibleBookEntries, tx);

      const assignmentsResult =
        await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
          projectUnit.id,
          bibleId,
          bookId,
          tx
        );

      if (!assignmentsResult.ok) {
        throw new Error(assignmentsResult.error.message || 'Failed to create chapter assignments');
      }

      return ok(project);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create project',
      context: {
        organization: input.organization,
        bibleId: input.bibleId,
        bookId: input.bookId,
      },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateProject(
  id: number,
  input: UpdateProjectInput
): Promise<Result<Project>> {
  try {
    return await db.transaction(async (tx) => {
      const { bibleId, bookId, projectUnitStatus, ...projectData } = input;

      const updatedProject = await repo.updateProjectRecord(id, projectData, tx);

      if (!updatedProject) {
        return err(ErrorCode.PROJECT_NOT_FOUND);
      }

      if (projectUnitStatus !== undefined) {
        await repo.updateProjectUnitStatusByProjectId(id, projectUnitStatus, tx);
      }

      return ok(updatedProject);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update project',
      context: { projectId: id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
