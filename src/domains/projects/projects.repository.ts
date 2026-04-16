import { and, eq, inArray } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_books,
  chapter_assignments,
  chapterStatusEnum,
  project_unit_bible_books,
  project_units,
  project_users,
  projects,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { RawProjectRow } from './projects.query-builder';
import type {
  ChapterStatusCounts,
  CreateProjectData,
  Project,
  ProjectUnitRef,
  ProjectWithLanguageNames,
  UpdateProjectData,
  WorkflowStep,
} from './projects.types';

import { baseJoinQuery } from './projects.query-builder';

const formatLabel = (str: string) =>
  str
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

const WORKFLOW_DEFINITION: WorkflowStep[] = chapterStatusEnum.enumValues.map((status) => ({
  id: status,
  label: formatLabel(status),
}));

// NOTE: mapper lives here because it is tightly coupled to the raw join shape from baseJoinQuery.
export function mapToProjectWithLanguages(rawProject: RawProjectRow): ProjectWithLanguageNames {
  const { counts, ...rest } = rawProject;
  const defaultCounts = chapterStatusEnum.enumValues.reduce((acc, status) => {
    acc[status] = 0;
    return acc;
  }, {} as ChapterStatusCounts);

  return {
    ...rest,
    chapterStatusCounts: { ...defaultCounts, ...(counts || {}) },
    workflowConfig: WORKFLOW_DEFINITION,
  };
}

// Repository functions

export async function getByOrganization(
  organizationId: number
): Promise<Result<ProjectWithLanguageNames[]>> {
  try {
    const rawProjects = await baseJoinQuery().where(eq(projects.organization, organizationId));
    return ok(rawProjects.map(mapToProjectWithLanguages));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get projects by organization',
      context: { organizationId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByUserId(userId: number): Promise<Result<ProjectWithLanguageNames[]>> {
  try {
    const rawProjects = await baseJoinQuery()
      .innerJoin(project_users, eq(project_users.projectId, projects.id))
      .where(eq(project_users.userId, userId));
    return ok(rawProjects.map(mapToProjectWithLanguages));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get projects by user ID',
      context: { userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<ProjectWithLanguageNames>> {
  try {
    const rawProjects = await baseJoinQuery().where(eq(projects.id, id)).limit(1);
    if (rawProjects.length === 0) return err(ErrorCode.PROJECT_NOT_FOUND);
    return ok(mapToProjectWithLanguages(rawProjects[0]));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get project by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getValidBookIdsForBible(bibleId: number): Promise<number[]> {
  const rows = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bibleId));
  return rows.map((r) => r.bookId);
}

export async function insertProjectRecord(
  projectData: CreateProjectData,
  tx: DbTransaction
): Promise<Project> {
  const [project] = await tx.insert(projects).values(projectData).returning();
  return project;
}

export async function insertProjectUnitRecord(
  unitData: { projectId: number; status: 'not_started' | 'in_progress' | 'completed' },
  tx: DbTransaction
) {
  const [projectUnit] = await tx.insert(project_units).values(unitData).returning();
  return projectUnit;
}

export async function insertBibleBookLinks(
  bibleBookEntries: { projectUnitId: number; bibleId: number; bookId: number }[],
  tx: DbTransaction
) {
  if (bibleBookEntries.length > 0) {
    await tx.insert(project_unit_bible_books).values(bibleBookEntries);
  }
}

export async function updateProjectRecord(
  id: number,
  projectData: UpdateProjectData,
  tx: DbTransaction
): Promise<Project | undefined> {
  const [updated] = await tx
    .update(projects)
    .set(projectData)
    .where(eq(projects.id, id))
    .returning();
  return updated;
}

export async function updateProjectUnitStatusByProjectId(
  projectId: number,
  status: 'not_started' | 'in_progress' | 'completed',
  tx: DbTransaction
) {
  await tx.update(project_units).set({ status }).where(eq(project_units.projectId, projectId));
}

export async function remove(id: number): Promise<Result<void>> {
  try {
    const [deleted] = await db
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    if (!deleted) return err(ErrorCode.PROJECT_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to delete project', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getProjectIdByUnitId(projectUnitId: number): Promise<Result<ProjectUnitRef>> {
  try {
    const [unit] = await db
      .select({ projectId: project_units.projectId })
      .from(project_units)
      .where(eq(project_units.id, projectUnitId))
      .limit(1);

    if (!unit) return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
    return ok({ projectId: unit.projectId });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project unit ID by project ID',
      context: { projectUnitId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findAssignmentIdsNotInProject(
  projectId: number,
  chapterAssignmentIds: number[],
  tx: DbTransaction
): Promise<number[]> {
  const rows = await tx
    .select({ id: chapter_assignments.id })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
    .where(
      and(
        inArray(chapter_assignments.id, chapterAssignmentIds),
        eq(project_units.projectId, projectId)
      )
    );

  const validIds = new Set(rows.map((r) => r.id));
  return chapterAssignmentIds.filter((id) => !validIds.has(id));
}
