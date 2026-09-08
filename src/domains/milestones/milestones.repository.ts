import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import {
  bible_books,
  chapter_assignments,
  project_unit_bible_books,
  project_units,
} from '@/db/schema';

import type { CreateMilestoneInput, UpdateMilestoneInput } from './milestones.types';

export async function insertMilestoneRecord(
  projectId: number,
  input: Omit<CreateMilestoneInput, 'bibleId' | 'bookIds'>,
  tx: DbTransaction
) {
  const [milestone] = await tx
    .insert(project_units)
    .values({
      projectId,
      name: input.name,
      type: input.type,
      status: input.status,
    })
    .returning();
  return milestone;
}

export async function insertBibleBookLinks(
  links: { projectUnitId: number; bibleId: number; bookId: number }[],
  tx: DbTransaction
) {
  await tx.insert(project_unit_bible_books).values(links);
}

export async function getValidBookIdsForBible(bibleId: number, requestedBookIds: number[]) {
  const validBooks = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bibleId));
  const validBookIdSet = new Set(validBooks.map((b) => b.bookId));
  return requestedBookIds.filter((id) => validBookIdSet.has(id));
}

export async function getMilestonesByProjectId(projectId: number) {
  const rows = await db
    .select({
      milestone: project_units,
      bookCount: sql<number>`(
        SELECT count(*)::int FROM project_unit_bible_books
        WHERE project_unit_id = ${project_units.id}
      )`.as('book_count'),
      chapterStatusCounts: sql<Record<string, number>>`(
        SELECT jsonb_object_agg(status, count) FROM (
          SELECT status, count(*) as count FROM chapter_assignments
          WHERE project_unit_id = ${project_units.id}
          GROUP BY status
        ) t
      )`.as('counts'),
    })
    .from(project_units)
    .where(eq(project_units.projectId, projectId));

  return rows.map((row) => ({
    ...row.milestone,
    bookCount: row.bookCount ?? 0,
    chapterStatusCounts: row.chapterStatusCounts ?? {},
  }));
}

export async function getMilestoneById(id: number, tx?: DbTransaction) {
  const conn = tx ?? db;
  const [milestone] = await conn.select().from(project_units).where(eq(project_units.id, id));
  return milestone;
}

export async function updateMilestoneRecord(
  id: number,
  input: Omit<UpdateMilestoneInput, 'moveBooks'>,
  tx: DbTransaction
) {
  const updateData: any = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.type !== undefined) updateData.type = input.type;
  if (input.status !== undefined) updateData.status = input.status;

  if (Object.keys(updateData).length === 0) {
    return await getMilestoneById(id, tx); // no-op update
  }

  const [milestone] = await tx
    .update(project_units)
    .set(updateData)
    .where(eq(project_units.id, id))
    .returning();
  return milestone;
}

export async function deleteMilestoneRecord(id: number) {
  await db.delete(project_units).where(eq(project_units.id, id));
}

export async function getBooksForMilestone(milestoneId: number) {
  return await db
    .select()
    .from(project_unit_bible_books)
    .where(eq(project_unit_bible_books.projectUnitId, milestoneId));
}

export async function deleteBibleBookLinks(
  projectUnitId: number,
  bookIds: number[],
  tx?: DbTransaction
) {
  const conn = tx ?? db;
  await conn
    .delete(project_unit_bible_books)
    .where(
      and(
        eq(project_unit_bible_books.projectUnitId, projectUnitId),
        inArray(project_unit_bible_books.bookId, bookIds)
      )
    );
}

export async function moveBookToMilestone(
  bookId: number,
  currentMilestoneId: number,
  targetMilestoneId: number,
  tx: DbTransaction
) {
  await tx
    .update(project_unit_bible_books)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(project_unit_bible_books.projectUnitId, currentMilestoneId),
        eq(project_unit_bible_books.bookId, bookId)
      )
    );

  await tx
    .update(chapter_assignments)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(chapter_assignments.projectUnitId, currentMilestoneId),
        eq(chapter_assignments.bookId, bookId)
      )
    );
}
