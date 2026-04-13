import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_texts,
  bibles,
  books,
  chapter_assignments,
  languages,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { UserChapterAssignment } from './users-chapter-assignments.types';

const MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST = 1000;
const sourceLang = alias(languages, 'source_lang');

interface QueryRow {
  assignmentId: number;
  projectId: number;
  projectName: string;
  projectUnitId: number;
  bibleId: number;
  bibleName: string;
  chapterStatus: string;
  targetLanguage: string;
  bookId: number;
  bookName: string;
  bookCode: string;
  sourceLangCode: string | null;
  chapterNumber: number;
  submittedTime: Date | null;
  totalVerses: number;
  completedVerses: number;
  assignedUserId: number | null;
  peerCheckerId: number | null;
  updatedAt: Date | null;
}

function createBaseQuery() {
  return db
    .select({
      assignmentId: chapter_assignments.id,
      projectId: projects.id,
      projectName: projects.name,
      projectUnitId: chapter_assignments.projectUnitId,
      bibleId: chapter_assignments.bibleId,
      bibleName: bibles.name,
      chapterStatus: chapter_assignments.status,
      targetLanguage: languages.langName,
      bookId: chapter_assignments.bookId,
      bookName: books.eng_display_name,
      bookCode: books.code,
      sourceLangCode: sourceLang.langCodeIso6393,
      chapterNumber: chapter_assignments.chapterNumber,
      submittedTime: chapter_assignments.submittedTime,
      totalVerses: sql<number>`COUNT(${bible_texts.id})`,
      completedVerses: sql<number>`COUNT(CASE WHEN ${translated_verses.content} != '' AND ${translated_verses.content} IS NOT NULL THEN 1 END)`,
      assignedUserId: chapter_assignments.assignedUserId,
      peerCheckerId: chapter_assignments.peerCheckerId,
      updatedAt: chapter_assignments.updatedAt,
    })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
    .innerJoin(projects, eq(project_units.projectId, projects.id))
    .innerJoin(bibles, eq(chapter_assignments.bibleId, bibles.id))
    .innerJoin(languages, eq(projects.targetLanguage, languages.id))
    .innerJoin(sourceLang, eq(projects.sourceLanguage, sourceLang.id))
    .innerJoin(books, eq(chapter_assignments.bookId, books.id))
    .innerJoin(
      bible_texts,
      and(
        eq(bible_texts.bibleId, chapter_assignments.bibleId),
        eq(bible_texts.bookId, chapter_assignments.bookId),
        eq(bible_texts.chapterNumber, chapter_assignments.chapterNumber)
      )
    )
    .leftJoin(
      translated_verses,
      and(
        eq(translated_verses.bibleTextId, bible_texts.id),
        eq(translated_verses.projectUnitId, chapter_assignments.projectUnitId)
      )
    )
    .groupBy(
      chapter_assignments.id,
      chapter_assignments.projectUnitId,
      chapter_assignments.bibleId,
      chapter_assignments.bookId,
      chapter_assignments.chapterNumber,
      chapter_assignments.submittedTime,
      chapter_assignments.assignedUserId,
      chapter_assignments.peerCheckerId,
      chapter_assignments.updatedAt,
      projects.id,
      projects.name,
      bibles.name,
      languages.langName,
      sourceLang.langCodeIso6393,
      books.eng_display_name,
      books.code
    )
    .orderBy(projects.name, books.eng_display_name, chapter_assignments.chapterNumber);
}

function mapRows(rows: QueryRow[]): UserChapterAssignment[] {
  return rows.map((row) => ({
    chapterAssignmentId: row.assignmentId,
    projectId: row.projectId,
    projectName: row.projectName,
    projectUnitId: row.projectUnitId,
    bibleId: row.bibleId,
    bookCode: row.bookCode,
    bibleName: row.bibleName,
    chapterStatus: row.chapterStatus,
    targetLanguage: row.targetLanguage,
    sourceLangCode: row.sourceLangCode ?? '',
    bookId: row.bookId,
    book: row.bookName,
    chapterNumber: row.chapterNumber,
    totalVerses: Number(row.totalVerses),
    completedVerses: Number(row.completedVerses),
    submittedTime: row.submittedTime?.toISOString() ?? null,
    assignedUserId: row.assignedUserId,
    peerCheckerId: row.peerCheckerId,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  }));
}

export async function findAssignedByUserId(
  userId: number
): Promise<Result<UserChapterAssignment[]>> {
  try {
    const rows = await createBaseQuery().where(eq(chapter_assignments.assignedUserId, userId));
    return ok(mapRows(rows));
  } catch (e) {
    logger.error({ cause: e, message: 'Failed to fetch assigned chapters', context: { userId } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findPeerCheckByUserId(
  userId: number
): Promise<Result<UserChapterAssignment[]>> {
  try {
    const rows = await createBaseQuery().where(
      and(
        eq(chapter_assignments.peerCheckerId, userId),
        eq(chapter_assignments.status, 'peer_check')
      )
    );
    return ok(mapRows(rows));
  } catch (e) {
    logger.error({
      cause: e,
      message: 'Failed to fetch peer check chapters',
      context: { userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export interface CurrentAssignmentRow {
  id: number;
  status: string;
  assignedUserId: number | null;
  peerCheckerId: number | null;
  projectUnitId: number;
}

export async function findCurrentAssignments(
  ids: number[],
  tx: DbTransaction
): Promise<CurrentAssignmentRow[]> {
  return tx
    .select({
      id: chapter_assignments.id,
      status: chapter_assignments.status,
      assignedUserId: chapter_assignments.assignedUserId,
      peerCheckerId: chapter_assignments.peerCheckerId,
      projectUnitId: chapter_assignments.projectUnitId,
    })
    .from(chapter_assignments)
    .where(inArray(chapter_assignments.id, ids));
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

export interface BulkUpdateResult {
  id: number;
  status: string;
}

export async function bulkUpdateAssignments(
  ids: number[],
  assignedUserId: number | null,
  peerCheckerId: number | null,
  tx: DbTransaction
): Promise<BulkUpdateResult[]> {
  return tx
    .update(chapter_assignments)
    .set({
      assignedUserId,
      peerCheckerId,
      status: sql`
        CASE
          WHEN ${chapter_assignments.status} = 'not_started' THEN 'draft'::chapter_status
          ELSE ${chapter_assignments.status}
        END`,
    })
    .where(inArray(chapter_assignments.id, ids))
    .returning({ id: chapter_assignments.id, status: chapter_assignments.status });
}

export { MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST };
