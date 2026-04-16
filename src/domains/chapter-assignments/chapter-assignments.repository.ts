import { and, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { DbTransaction, Result, USJDocument } from '@/lib/types';
import type { VerseData } from '@/lib/usfm-converter';

import { db } from '@/db';
import {
  bible_texts,
  bibles,
  books,
  chapter_assignment_assigned_user_history,
  chapter_assignment_snapshots,
  chapter_assignment_status_history,
  chapter_assignments,
  languages,
  project_units,
  project_users,
  projects,
  translated_verses,
  users,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import { convertUSFMToUSJ, generateUSFMText } from '@/lib/usfm-converter';

import type { PolicyChapterAssignment } from './chapter-assignments.policy';
import type {
  ChapterAssignmentProgressInfo,
  ChapterAssignmentRecord,
  ChapterAssignmentRecordWithOrg,
  ChapterAssignmentStatus,
  CreateChapterAssignmentRequestData,
  UpdateChapterAssignmentRequestData,
} from './chapter-assignments.types';

export interface ChapterAssignmentWithAuthContext extends ChapterAssignmentRecord {
  projectId: number;
  organizationId: number;
  isProjectMember: boolean;
}

const USJ_SPEC_VERSION = '0.0.1';

export async function findById(
  id: number,
  tx?: DbTransaction
): Promise<ChapterAssignmentRecord | null> {
  const conn = tx ?? db;
  const [assignment] = await conn
    .select()
    .from(chapter_assignments)
    .where(eq(chapter_assignments.id, id))
    .limit(1);
  return assignment ?? null;
}

export async function findByIdWithOrg(id: number): Promise<Result<ChapterAssignmentRecordWithOrg>> {
  try {
    const [assignment] = await db
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
        organizationId: projects.organization,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(eq(chapter_assignments.id, id))
      .limit(1);

    if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    return ok(assignment);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to fetch chapter assignment', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByIdWithAuthContext(
  id: number,
  userId: number,
  roleName: string
): Promise<Result<ChapterAssignmentWithAuthContext>> {
  try {
    const [assignment] = await db
      .select({
        // Assignment fields
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
        // Project context
        projectId: projects.id,
        organizationId: projects.organization,
        // Project membership (LEFT JOIN to handle non-members)
        isProjectMember: sql<boolean>`CASE WHEN ${project_users.userId} IS NOT NULL THEN true ELSE false END`,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .leftJoin(
        project_users,
        and(
          eq(project_users.projectId, projects.id),
          eq(project_users.userId, userId),
          // Only check membership for translators (per resolveIsProjectMember logic)
          roleName === 'translator' ? sql`1=1` : sql`1=0`
        )
      )
      .where(eq(chapter_assignments.id, id))
      .limit(1);

    if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    return ok(assignment);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to fetch chapter assignment with auth context',
      context: { id, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findForVerse(
  projectUnitId: number,
  bibleTextId: number
): Promise<Result<PolicyChapterAssignment>> {
  try {
    const [bibleText] = await db
      .select({ bookId: bible_texts.bookId, chapterNumber: bible_texts.chapterNumber })
      .from(bible_texts)
      .where(eq(bible_texts.id, bibleTextId))
      .limit(1);

    if (!bibleText) return err(ErrorCode.INVALID_REFERENCE);

    const [assignment] = await db
      .select({
        assignedUserId: chapter_assignments.assignedUserId,
        peerCheckerId: chapter_assignments.peerCheckerId,
        status: chapter_assignments.status,
        organizationId: projects.organization,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(
        and(
          eq(chapter_assignments.projectUnitId, projectUnitId),
          eq(chapter_assignments.bookId, bibleText.bookId),
          eq(chapter_assignments.chapterNumber, bibleText.chapterNumber)
        )
      )
      .limit(1);

    if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    return ok(assignment);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to resolve chapter assignment for verse',
      context: { projectUnitId, bibleTextId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findChaptersForProjectUnit(
  bibleId: number,
  bookIds: number[],
  tx: DbTransaction
) {
  return tx
    .select({
      bibleId: bible_texts.bibleId,
      bookId: bible_texts.bookId,
      chapterNumber: bible_texts.chapterNumber,
    })
    .from(bible_texts)
    .where(and(eq(bible_texts.bibleId, bibleId), inArray(bible_texts.bookId, bookIds)))
    .groupBy(bible_texts.bibleId, bible_texts.bookId, bible_texts.chapterNumber)
    .orderBy(bible_texts.bookId, bible_texts.chapterNumber);
}

export async function getContent(
  tx: DbTransaction,
  assignment: ChapterAssignmentRecord
): Promise<Result<USJDocument>> {
  try {
    const verses = await tx
      .select({
        id: translated_verses.id,
        content: translated_verses.content,
        verseNumber: bible_texts.verseNumber,
        bibleTextId: bible_texts.id,
        bookCode: books.code,
        bookName: books.eng_display_name,
      })
      .from(translated_verses)
      .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id))
      .innerJoin(books, eq(bible_texts.bookId, books.id))
      .where(
        and(
          eq(translated_verses.projectUnitId, assignment.projectUnitId),
          eq(bible_texts.chapterNumber, assignment.chapterNumber),
          eq(bible_texts.bookId, assignment.bookId),
          eq(bible_texts.bibleId, assignment.bibleId)
        )
      )
      .orderBy(bible_texts.verseNumber);

    if (verses.length === 0) {
      logger.warn('No translated verses found for assignment', {
        assignmentId: assignment.id,
        chapterNumber: assignment.chapterNumber,
      });
      return ok({ type: 'USJ', version: USJ_SPEC_VERSION, content: [] });
    }

    const verseData: VerseData[] = verses.map((v) => ({
      bookId: assignment.bookId,
      bookCode: v.bookCode,
      bookName: v.bookName,
      chapterNumber: assignment.chapterNumber,
      verseNumber: v.verseNumber,
      translatedContent: v.content,
    }));

    const conversionResult = convertUSFMToUSJ(generateUSFMText(verseData));
    if (!conversionResult.ok) {
      logger.error('Failed to convert USFM to USJ', {
        assignmentId: assignment.id,
        error: conversionResult.error,
      });
      return conversionResult;
    }

    return ok(conversionResult.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to generate assignment content',
      context: { assignmentId: assignment.id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insert(
  data: CreateChapterAssignmentRequestData,
  tx: DbTransaction
): Promise<ChapterAssignmentRecord> {
  const [assignment] = await tx.insert(chapter_assignments).values(data).returning();
  return assignment;
}

export async function insertMany(
  records: Array<{
    projectUnitId: number;
    bibleId: number;
    bookId: number;
    chapterNumber: number;
    assignedUserId: null;
    peerCheckerId: null;
  }>,
  tx: DbTransaction
): Promise<ChapterAssignmentRecord[]> {
  const chunkSize = 1000;
  const inserted: ChapterAssignmentRecord[] = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const result = await tx.insert(chapter_assignments).values(chunk).returning();
    inserted.push(...result);
  }
  return inserted;
}

export async function update(
  id: number,
  data: UpdateChapterAssignmentRequestData,
  tx: DbTransaction
): Promise<ChapterAssignmentRecord | null> {
  const [updated] = await tx
    .update(chapter_assignments)
    .set(data)
    .where(eq(chapter_assignments.id, id))
    .returning();
  return updated ?? null;
}

export async function remove(id: number): Promise<Result<void>> {
  try {
    const [deleted] = await db
      .delete(chapter_assignments)
      .where(eq(chapter_assignments.id, id))
      .returning({ id: chapter_assignments.id });
    if (!deleted) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to delete chapter assignment', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insertStatusHistory(
  tx: DbTransaction,
  chapterAssignmentId: number,
  status: ChapterAssignmentStatus
): Promise<void> {
  await tx.insert(chapter_assignment_status_history).values({ chapterAssignmentId, status });
}

export async function insertUserAssignmentHistory(
  tx: DbTransaction,
  chapterAssignmentId: number,
  assignedUserId: number,
  role: 'drafter' | 'peer_checker',
  status: ChapterAssignmentStatus
): Promise<void> {
  await tx
    .insert(chapter_assignment_assigned_user_history)
    .values({ chapterAssignmentId, assignedUserId, role, status });
}

export async function insertSnapshot(
  tx: DbTransaction,
  data: {
    chapterAssignmentId: number;
    status: ChapterAssignmentStatus;
    assignedUserId: number | null;
    content: USJDocument;
  }
): Promise<void> {
  await tx.insert(chapter_assignment_snapshots).values(data);
}

export async function findAssignmentsProgress(
  filters: {
    projectId?: number;
    assignedUserId?: number;
    peerCheckerId?: number;
    status?: ChapterAssignmentStatus;
  },
  tx?: DbTransaction
): Promise<Result<ChapterAssignmentProgressInfo[]>> {
  try {
    const conn = tx ?? db;
    const assignedUser = alias(users, 'assignedUser');
    const peerChecker = alias(users, 'peerChecker');
    const sourceLang = alias(languages, 'sourceLang');
    const targetLang = alias(languages, 'targetLang');

    const baseQuery = conn
      .select({
        assignmentId: chapter_assignments.id,
        projectId: projects.id,
        projectName: projects.name,
        projectUnitId: chapter_assignments.projectUnitId,
        bibleId: chapter_assignments.bibleId,
        bibleName: bibles.name,
        bookId: chapter_assignments.bookId,
        bookCode: books.code,
        bookNameEng: books.eng_display_name,
        chapterNumber: chapter_assignments.chapterNumber,
        status: chapter_assignments.status,
        targetLanguage: targetLang.langName,
        sourceLangCode: sourceLang.langCodeIso6393,
        totalVerses: sql<number>`COUNT(${bible_texts.id})`.mapWith(Number),
        completedVerses:
          sql<number>`COUNT(CASE WHEN ${translated_verses.content} != '' AND ${translated_verses.content} IS NOT NULL THEN 1 END)`.mapWith(
            Number
          ),
        assignedUserId: chapter_assignments.assignedUserId,
        assignedUserDisplayName: assignedUser.username,
        peerCheckerId: chapter_assignments.peerCheckerId,
        peerCheckerDisplayName: peerChecker.username,
        submittedTime: chapter_assignments.submittedTime,
        createdAt: chapter_assignments.createdAt,
        updatedAt: chapter_assignments.updatedAt,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .innerJoin(books, eq(chapter_assignments.bookId, books.id))
      .innerJoin(bibles, eq(bibles.id, chapter_assignments.bibleId))
      .leftJoin(targetLang, eq(projects.targetLanguage, targetLang.id))
      .leftJoin(sourceLang, eq(projects.sourceLanguage, sourceLang.id))
      .leftJoin(assignedUser, eq(chapter_assignments.assignedUserId, assignedUser.id))
      .leftJoin(peerChecker, eq(chapter_assignments.peerCheckerId, peerChecker.id))
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
      );

    const conditions = [];
    if (filters.projectId !== undefined) {
      conditions.push(eq(project_units.projectId, filters.projectId));
    }
    if (filters.assignedUserId !== undefined) {
      conditions.push(eq(chapter_assignments.assignedUserId, filters.assignedUserId));
    }
    if (filters.peerCheckerId !== undefined) {
      conditions.push(eq(chapter_assignments.peerCheckerId, filters.peerCheckerId));
    }
    if (filters.status !== undefined) {
      conditions.push(eq(chapter_assignments.status, filters.status));
    }

    let finalQuery = baseQuery;
    if (conditions.length > 0) {
      finalQuery = finalQuery.where(and(...conditions)) as any;
    }

    const rows = await finalQuery
      .groupBy(
        chapter_assignments.id,
        projects.id,
        projects.name,
        bibles.name,
        targetLang.langName,
        sourceLang.langCodeIso6393,
        books.code,
        books.eng_display_name,
        assignedUser.username,
        peerChecker.username
      )
      .orderBy(projects.name, books.eng_display_name, chapter_assignments.chapterNumber);

    return ok(rows);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find assignments progress',
      context: { filters },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
