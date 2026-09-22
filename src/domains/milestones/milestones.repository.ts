import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import {
  bible_books,
  bible_texts,
  chapter_assignments,
  chapterStatusEnum,
  project_unit_bible_books,
  project_units,
  projects,
  translated_verses,
  verse_audio_recordings,
} from '@/db/schema';

import type { CreateMilestoneInput, MilestoneRow, UpdateMilestoneInput } from './milestones.types';

export async function insertMilestoneRecord(
  projectId: number,
  input: Omit<CreateMilestoneInput, 'bookIds'>,
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

function milestoneSelect(conn: typeof db | DbTransaction = db) {
  return conn
    .select({
      id: project_units.id,
      name: project_units.name,
      status: project_units.status,
      type: project_units.type,
      projectId: project_units.projectId,
      projectName: projects.name,
      milestoneCount: sql<number>`(
        SELECT count(*)::int FROM project_units pu
        WHERE pu.project_id = project_units.project_id
      )`.as('milestone_count'),
      bookCount: sql<number>`(
        SELECT count(*)::int FROM project_unit_bible_books
        WHERE project_unit_id = project_units.id
      )`.as('book_count'),
      bookIds: sql<number[]>`COALESCE((
        SELECT array_agg(book_id)
        FROM project_unit_bible_books
        WHERE project_unit_id = project_units.id
      ), ARRAY[]::integer[])`.as('book_ids'),
      chapterStatusCounts: sql<Record<string, number>>`COALESCE((
        SELECT jsonb_object_agg(chapter_status, count) FROM (
          SELECT chapter_status, count(*) as count FROM chapter_assignments
          WHERE project_unit_id = project_units.id
          GROUP BY chapter_status
        ) t
      ), '{}'::jsonb)`.as('counts'),
      updatedAt: project_units.updatedAt,
    })
    .from(project_units)
    .innerJoin(projects, eq(projects.id, project_units.projectId));
}

function mapRow(row: any): MilestoneRow {
  const defaultCounts = chapterStatusEnum.enumValues.reduce(
    (acc, status) => {
      acc[status] = 0;
      return acc;
    },
    {} as Record<string, number>
  );

  return {
    ...row,
    bookCount: row.bookCount ?? 0,
    bookIds: row.bookIds ?? [],
    chapterStatusCounts: {
      ...defaultCounts,
      ...(row.chapterStatusCounts || {}),
    },
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listByProjectId(projectId: number): Promise<MilestoneRow[]> {
  const rows = await milestoneSelect().where(eq(project_units.projectId, projectId));
  return rows.map(mapRow);
}

export async function listByProjectIds(projectIds: number[]): Promise<MilestoneRow[]> {
  if (projectIds.length === 0) return [];
  const rows = await milestoneSelect().where(inArray(project_units.projectId, projectIds));
  return rows.map(mapRow);
}

export async function getByIdForProject(
  projectId: number,
  milestoneId: number,
  tx?: DbTransaction
): Promise<MilestoneRow | null> {
  const conn = tx ?? db;
  const rows = await milestoneSelect(conn).where(
    and(eq(project_units.id, milestoneId), eq(project_units.projectId, projectId))
  );
  if (rows.length === 0) return null;
  return mapRow(rows[0]);
}

// Keep getMilestoneById for internal checks where only ID is known
export async function getMilestoneById(id: number, tx?: DbTransaction) {
  const conn = tx ?? db;
  const [milestone] = await conn.select().from(project_units).where(eq(project_units.id, id));
  return milestone;
}

export async function updateMilestoneRecord(
  id: number,
  input: Omit<UpdateMilestoneInput, 'moveBooks' | 'bibleId' | 'addBooks' | 'removeBooks'>,
  tx: DbTransaction
) {
  const updateData: Partial<typeof project_units.$inferInsert> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.type !== undefined) updateData.type = input.type;
  if (input.status !== undefined) updateData.status = input.status;

  if (Object.keys(updateData).length === 0) {
    return await getMilestoneById(id, tx);
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
  if (bookIds.length === 0) return;
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
  // 1. Move the bible book link
  await tx
    .update(project_unit_bible_books)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(project_unit_bible_books.projectUnitId, currentMilestoneId),
        eq(project_unit_bible_books.bookId, bookId)
      )
    );

  // 2. Move chapter assignments
  await tx
    .update(chapter_assignments)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(chapter_assignments.projectUnitId, currentMilestoneId),
        eq(chapter_assignments.bookId, bookId)
      )
    );

  // Subquery: all bible_text IDs that belong to this book
  const bibleTextIdsForBook = tx
    .select({ id: bible_texts.id })
    .from(bible_texts)
    .where(eq(bible_texts.bookId, bookId));

  // 3. Move translated verses
  await tx
    .update(translated_verses)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(translated_verses.projectUnitId, currentMilestoneId),
        inArray(translated_verses.bibleTextId, bibleTextIdsForBook)
      )
    );

  // 4. Move verse audio recordings
  await tx
    .update(verse_audio_recordings)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(verse_audio_recordings.projectUnitId, currentMilestoneId),
        inArray(verse_audio_recordings.bibleTextId, bibleTextIdsForBook)
      )
    );
}

export async function deleteTranslatedDataForBooks(
  projectUnitId: number,
  bookIds: number[],
  tx: DbTransaction
) {
  if (bookIds.length === 0) return;

  const bibleTextIdsForBooks = tx
    .select({ id: bible_texts.id })
    .from(bible_texts)
    .where(inArray(bible_texts.bookId, bookIds));

  // Delete translated verses
  await tx
    .delete(translated_verses)
    .where(
      and(
        eq(translated_verses.projectUnitId, projectUnitId),
        inArray(translated_verses.bibleTextId, bibleTextIdsForBooks)
      )
    );

  // Delete verse audio recordings
  await tx
    .delete(verse_audio_recordings)
    .where(
      and(
        eq(verse_audio_recordings.projectUnitId, projectUnitId),
        inArray(verse_audio_recordings.bibleTextId, bibleTextIdsForBooks)
      )
    );
}
