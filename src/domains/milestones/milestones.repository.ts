import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import {
  ai_suggestion_usage_log,
  ai_suggestions,
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

export async function getValidBookIdsForBible(
  bibleId: number,
  requestedBookIds: number[],
  tx: typeof db | DbTransaction = db
) {
  const validBooks = await tx
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bibleId));
  const validBookIdSet = new Set(validBooks.map((b) => b.bookId));
  return requestedBookIds.filter((id) => validBookIdSet.has(id));
}

export async function getExistingBookAssignmentsForProject(
  projectId: number,
  bookIds: number[],
  tx: typeof db | DbTransaction = db
) {
  if (bookIds.length === 0) return [];
  return tx
    .select({
      bookId: project_unit_bible_books.bookId,
      projectUnitId: project_unit_bible_books.projectUnitId,
      deletedAt: project_unit_bible_books.deletedAt,
    })
    .from(project_unit_bible_books)
    .innerJoin(project_units, eq(project_units.id, project_unit_bible_books.projectUnitId))
    .where(
      and(eq(project_units.projectId, projectId), inArray(project_unit_bible_books.bookId, bookIds))
    );
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
        WHERE project_unit_id = project_units.id AND deleted_at IS NULL
      )`.as('book_count'),
      bookIds: sql<number[]>`COALESCE((
        SELECT array_agg(book_id)
        FROM project_unit_bible_books
        WHERE project_unit_id = project_units.id AND deleted_at IS NULL
      ), ARRAY[]::integer[])`.as('book_ids'),
      chapterStatusCounts: sql<Record<string, number>>`COALESCE((
        SELECT jsonb_object_agg(chapter_status, count) FROM (
          SELECT ca.chapter_status, count(*) as count FROM chapter_assignments ca
          INNER JOIN project_unit_bible_books pubb ON pubb.project_unit_id = ca.project_unit_id AND pubb.book_id = ca.book_id
          WHERE ca.project_unit_id = project_units.id AND pubb.deleted_at IS NULL
          GROUP BY ca.chapter_status
        ) t
      ), '{}'::jsonb)`.as('counts'),
      createdAt: project_units.createdAt,
      updatedAt: project_units.updatedAt,
    })
    .from(project_units)
    .innerJoin(projects, eq(projects.id, project_units.projectId));
}

type MilestoneSelectRow = Awaited<ReturnType<typeof milestoneSelect>>[number];

function mapRow(row: MilestoneSelectRow): MilestoneRow {
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
    createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listByProjectId(projectId: number): Promise<MilestoneRow[]> {
  const rows = await milestoneSelect().where(eq(project_units.projectId, projectId));
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
  return milestone ?? null;
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

export async function hasAnyBooks(milestoneId: number, tx?: DbTransaction): Promise<boolean> {
  const conn = tx ?? db;
  const [row] = await conn
    .select({ count: sql<number>`count(*)::int` })
    .from(project_unit_bible_books)
    .where(eq(project_unit_bible_books.projectUnitId, milestoneId));
  return (row?.count ?? 0) > 0;
}

export async function deleteMilestoneRecord(id: number, tx?: DbTransaction) {
  const conn = tx ?? db;
  await conn.delete(project_units).where(eq(project_units.id, id));
}

export async function deleteBibleBookLinks(
  projectUnitId: number,
  bookIds: number[],
  tx?: DbTransaction
) {
  const conn = tx ?? db;
  if (bookIds.length === 0) return;
  await conn
    .update(project_unit_bible_books)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(project_unit_bible_books.projectUnitId, projectUnitId),
        inArray(project_unit_bible_books.bookId, bookIds),
        isNull(project_unit_bible_books.deletedAt)
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
    .set({ projectUnitId: targetMilestoneId, deletedAt: null })
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

  // 5. Move AI suggestions
  await tx
    .update(ai_suggestions)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(ai_suggestions.projectUnitId, currentMilestoneId),
        inArray(ai_suggestions.bibleTextId, bibleTextIdsForBook)
      )
    );

  // 6. Move AI suggestion usage log
  await tx
    .update(ai_suggestion_usage_log)
    .set({ projectUnitId: targetMilestoneId })
    .where(
      and(
        eq(ai_suggestion_usage_log.projectUnitId, currentMilestoneId),
        inArray(ai_suggestion_usage_log.bibleTextId, bibleTextIdsForBook)
      )
    );
}
