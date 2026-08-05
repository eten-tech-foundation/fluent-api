import type { SQL } from 'drizzle-orm/sql';

import { and, eq, gt, inArray, or } from 'drizzle-orm';

import type { ChapterAssignmentRecord } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, projects } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterAssignmentWithProjectId } from './project-chapter-assignments.types';

export async function getByProject(projectId: number): Promise<Result<ChapterAssignmentRecord[]>> {
  try {
    const assignments = await db
      .select({
        id: chapter_assignments.id,
        projectUnitId: chapter_assignments.projectUnitId,
        bibleId: chapter_assignments.bibleId,
        bookId: chapter_assignments.bookId,
        chapterNumber: chapter_assignments.chapterNumber,
        assignedUserId: chapter_assignments.assignedUserId,
        peerCheckerId: chapter_assignments.peerCheckerId,
        status: chapter_assignments.status,
        submittedTime: chapter_assignments.submittedTime,
        isAiEnabled: chapter_assignments.isAiEnabled,
        createdAt: chapter_assignments.createdAt,
        updatedAt: chapter_assignments.updatedAt,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .where(eq(project_units.projectId, projectId));

    return ok(assignments);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project chapter assignments',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteByProject(
  projectId: number
): Promise<Result<{ deletedCount: number }>> {
  try {
    // Delete assignments across all of the project's units in one statement.
    // (Previously this selected a single unit with limit(1) and deleted only its
    // assignments, orphaning the rest if a project ever had more than one unit.)
    const deletedAssignments = await db
      .delete(chapter_assignments)
      .where(
        inArray(
          chapter_assignments.projectUnitId,
          db
            .select({ id: project_units.id })
            .from(project_units)
            .where(eq(project_units.projectId, projectId))
        )
      )
      .returning({ id: chapter_assignments.id });

    return ok({ deletedCount: deletedAssignments.length });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete chapter assignments for project',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getAssignmentIdsByProject(
  projectId: number,
  tx?: DbTransaction
): Promise<number[]> {
  const conn = tx ?? db;
  const rows = await conn
    .select({ id: chapter_assignments.id })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
    .where(eq(project_units.projectId, projectId));

  return rows.map((r) => r.id);
}

export async function findNotAssignedProjectIds(
  projectUnitIds: number[],
  tx: DbTransaction
): Promise<number[]> {
  const rows = await tx
    .select({ projectId: project_units.projectId })
    .from(project_units)
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .where(and(inArray(project_units.id, projectUnitIds), eq(projects.status, 'not_assigned')));
  return rows.map((r) => r.projectId);
}

export async function activateProjects(projectIds: number[], tx: DbTransaction): Promise<void> {
  if (projectIds.length === 0) return;
  await tx.update(projects).set({ status: 'active' }).where(inArray(projects.id, projectIds));
}

export async function findProjectUnitIdsByAssignmentIds(
  ids: number[],
  tx: DbTransaction
): Promise<number[]> {
  const rows = await tx
    .select({ projectUnitId: chapter_assignments.projectUnitId })
    .from(chapter_assignments)
    .where(inArray(chapter_assignments.id, ids));
  return [...new Set(rows.map((r) => r.projectUnitId))];
}

export const MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST = 1000;

export async function getByProjects(
  projectIds: number[],
  excludeProjectIds: number[] = [],
  updatedAfter?: Date
): Promise<Result<ChapterAssignmentWithProjectId[]>> {
  try {
    const assignments = await db
      .select({
        id: chapter_assignments.id,
        projectUnitId: chapter_assignments.projectUnitId,
        projectId: project_units.projectId,
        bibleId: chapter_assignments.bibleId,
        bookId: chapter_assignments.bookId,
        chapterNumber: chapter_assignments.chapterNumber,
        assignedUserId: chapter_assignments.assignedUserId,
        peerCheckerId: chapter_assignments.peerCheckerId,
        status: chapter_assignments.status,
        submittedTime: chapter_assignments.submittedTime,
        isAiEnabled: chapter_assignments.isAiEnabled,
        createdAt: chapter_assignments.createdAt,
        updatedAt: chapter_assignments.updatedAt,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .where(buildAssignmentFilter(projectIds, excludeProjectIds, updatedAfter));

    return ok(assignments);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get chapter assignments for projects',
      context: { projectIds, updatedAfter },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

function buildAssignmentFilter(
  projectIds: number[],
  excludeProjectIds: number[],
  updatedAfter: Date | undefined
) {
  const conditions: SQL[] = [];

  if (excludeProjectIds.length > 0) {
    const newIds = projectIds.filter((id) => !excludeProjectIds.includes(id));
    if (newIds.length > 0) {
      conditions.push(inArray(project_units.projectId, newIds));
    }
  }
  if (updatedAfter) {
    const syncedIds = excludeProjectIds.length > 0 ? excludeProjectIds : projectIds;
    const incrementalCondition = and(
      inArray(project_units.projectId, syncedIds),
      gt(chapter_assignments.updatedAt, updatedAfter)
    );
    if (incrementalCondition) conditions.push(incrementalCondition);
  }
  if (conditions.length === 0) return inArray(project_units.projectId, projectIds);

  return conditions.length === 1 ? conditions[0] : or(...conditions);
}
