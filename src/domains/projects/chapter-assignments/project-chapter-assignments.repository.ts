import { and, eq, inArray } from 'drizzle-orm';

import type { ChapterAssignmentRecord } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, projects } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

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
    return await db.transaction(async (tx) => {
      const [projectUnit] = await tx
        .select({ id: project_units.id })
        .from(project_units)
        .where(eq(project_units.projectId, projectId))
        .limit(1);

      if (!projectUnit) return ok({ deletedCount: 0 });

      const deletedAssignments = await tx
        .delete(chapter_assignments)
        .where(eq(chapter_assignments.projectUnitId, projectUnit.id))
        .returning({ id: chapter_assignments.id });

      return ok({ deletedCount: deletedAssignments.length });
    });
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
