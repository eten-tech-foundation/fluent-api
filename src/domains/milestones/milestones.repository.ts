import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  chapter_assignments,
  chapterStatusEnum,
  project_unit_bible_books,
  project_units,
  projects,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { MilestoneRow } from './milestones.types';

const defaultChapterCounts = () =>
  chapterStatusEnum.enumValues.reduce(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<string, number>
  );

const bookAgg = db
  .select({
    projectUnitId: project_unit_bible_books.projectUnitId,
    bookIds: sql<
      number[]
    >`coalesce(array_agg(${project_unit_bible_books.bookId} order by ${project_unit_bible_books.bookId}), '{}')`.as(
      'book_ids'
    ),
    bookCount: sql<number>`count(*)::int`.as('book_count'),
  })
  .from(project_unit_bible_books)
  .groupBy(project_unit_bible_books.projectUnitId)
  .as('milestone_books');

const rawCounts = db
  .select({
    projectUnitId: chapter_assignments.projectUnitId,
    status: chapter_assignments.status,
    count: sql<number>`count(*)::int`.as('count'),
  })
  .from(chapter_assignments)
  .groupBy(chapter_assignments.projectUnitId, chapter_assignments.status)
  .as('milestone_raw_counts');

const statusCounts = db
  .select({
    projectUnitId: rawCounts.projectUnitId,
    counts: sql<
      Record<string, number>
    >`jsonb_object_agg(${rawCounts.status}, ${rawCounts.count})`.as('counts'),
  })
  .from(rawCounts)
  .groupBy(rawCounts.projectUnitId)
  .as('milestone_status_counts');

const milestoneCountByProject = db
  .select({
    projectId: project_units.projectId,
    milestoneCount: sql<number>`count(*)::int`.as('milestone_count'),
  })
  .from(project_units)
  .groupBy(project_units.projectId)
  .as('milestone_counts_by_project');

function mapRow(row: {
  id: number;
  name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  type: 'text' | 'audio';
  connectivityProfile: string | null;
  projectId: number;
  projectName: string;
  milestoneCount: number | null;
  bookCount: number | null;
  bookIds: number[] | null;
  counts: Record<string, number> | null;
}): MilestoneRow {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    type: row.type,
    connectivityProfile: row.connectivityProfile,
    projectId: row.projectId,
    projectName: row.projectName,
    milestoneCount: Number(row.milestoneCount ?? 0),
    bookCount: Number(row.bookCount ?? 0),
    bookIds: row.bookIds ?? [],
    chapterStatusCounts: { ...defaultChapterCounts(), ...(row.counts || {}) },
  };
}

function milestoneSelect(conn: typeof db | DbTransaction) {
  return conn
    .select({
      id: project_units.id,
      name: project_units.name,
      status: project_units.status,
      type: project_units.type,
      connectivityProfile: project_units.connectivityProfile,
      projectId: projects.id,
      projectName: projects.name,
      milestoneCount: milestoneCountByProject.milestoneCount,
      bookCount: bookAgg.bookCount,
      bookIds: bookAgg.bookIds,
      counts: statusCounts.counts,
    })
    .from(project_units)
    .innerJoin(projects, eq(projects.id, project_units.projectId))
    .leftJoin(milestoneCountByProject, eq(milestoneCountByProject.projectId, projects.id))
    .leftJoin(bookAgg, eq(bookAgg.projectUnitId, project_units.id))
    .leftJoin(statusCounts, eq(statusCounts.projectUnitId, project_units.id));
}

export async function listByProjectId(projectId: number): Promise<Result<MilestoneRow[]>> {
  try {
    const rows = await milestoneSelect(db).where(eq(project_units.projectId, projectId));
    return ok(rows.map(mapRow));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to list milestones for project',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function listByProjectIds(projectIds: number[]): Promise<Result<MilestoneRow[]>> {
  if (projectIds.length === 0) return ok([]);
  try {
    const rows = await milestoneSelect(db).where(inArray(project_units.projectId, projectIds));
    return ok(rows.map(mapRow));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to list milestones for projects' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByIdForProject(
  projectId: number,
  milestoneId: number
): Promise<Result<MilestoneRow>> {
  try {
    const rows = await milestoneSelect(db).where(
      and(eq(project_units.projectId, projectId), eq(project_units.id, milestoneId))
    );
    if (rows.length === 0) return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
    return ok(mapRow(rows[0]));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get milestone',
      context: { projectId, milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insertMilestone(
  data: {
    projectId: number;
    name: string;
    status: 'not_started' | 'in_progress' | 'completed';
    type: 'text' | 'audio';
    connectivityProfile?: string | null;
  },
  tx: DbTransaction
) {
  const [unit] = await tx.insert(project_units).values(data).returning();
  return unit;
}

export async function updateMilestone(
  projectId: number,
  milestoneId: number,
  data: {
    name?: string;
    status?: 'not_started' | 'in_progress' | 'completed';
    type?: 'text' | 'audio';
    connectivityProfile?: string | null;
  }
): Promise<Result<void>> {
  try {
    const [updated] = await db
      .update(project_units)
      .set(data)
      .where(and(eq(project_units.id, milestoneId), eq(project_units.projectId, projectId)))
      .returning({ id: project_units.id });
    if (!updated) return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update milestone',
      context: { projectId, milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteMilestone(
  projectId: number,
  milestoneId: number
): Promise<Result<void>> {
  try {
    const [deleted] = await db
      .delete(project_units)
      .where(and(eq(project_units.id, milestoneId), eq(project_units.projectId, projectId)))
      .returning({ id: project_units.id });
    if (!deleted) return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete milestone',
      context: { projectId, milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
