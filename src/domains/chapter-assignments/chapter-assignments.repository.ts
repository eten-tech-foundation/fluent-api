import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbTransaction, Result, USJDocument } from '@/lib/types';
import type { VerseData } from '@/lib/usfm-converter';

import { db } from '@/db';
import {
  bible_texts,
  books,
  chapter_assignment_assigned_user_history,
  chapter_assignment_snapshots,
  chapter_assignment_status_history,
  chapter_assignments,
  project_units,
  projects,
  translated_verses,
} from '@/db/schema';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';
import { convertUSFMToUSJ, generateUSFMText } from '@/lib/usfm-converter';

import type { PolicyChapterAssignment } from './chapter-assignments.policy';
import type { StatusHistoryRow } from './chapter-assignments.stage-entered-at';
import type {
  ChapterAssignmentRecord,
  ChapterAssignmentRecordWithOrg,
  ChapterAssignmentStatus,
  CreateChapterAssignmentRequestData,
  UpdateChapterAssignmentRequestData,
} from './chapter-assignments.types';

import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

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
        isAiEnabled: chapter_assignments.isAiEnabled,
        hasClaimConflict: chapter_assignments.hasClaimConflict,
        claimConflictUserId: chapter_assignments.claimConflictUserId,
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
  userId: number
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
        isAiEnabled: chapter_assignments.isAiEnabled,
        hasClaimConflict: chapter_assignments.hasClaimConflict,
        claimConflictUserId: chapter_assignments.claimConflictUserId,
        createdAt: chapter_assignments.createdAt,
        updatedAt: chapter_assignments.updatedAt,
        // Project context
        projectId: projects.id,
        organizationId: projects.organization,
        // Project membership (LEFT JOIN to handle non-members)
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(eq(chapter_assignments.id, id))
      .limit(1);

    if (!assignment) return err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);

    const isProjectMember = await resolveIsProjectMember(assignment.projectId, userId);

    return ok({ ...assignment, isProjectMember });
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
      .select({
        bibleId: bible_texts.bibleId,
        bookId: bible_texts.bookId,
        chapterNumber: bible_texts.chapterNumber,
      })
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
        projectId: projects.id,
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .where(
        and(
          eq(chapter_assignments.projectUnitId, projectUnitId),
          eq(chapter_assignments.bibleId, bibleText.bibleId),
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
  externalTx?: DbTransaction
) {
  const dbClient = externalTx ?? db;
  return dbClient
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
        markers: translated_verses.markers,
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
      markers: v.markers,
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
  externalTx?: DbTransaction
): Promise<ChapterAssignmentRecord[]> {
  const dbClient = externalTx ?? db;
  const chunkSize = 1000;
  const inserted: ChapterAssignmentRecord[] = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize);
    const result = await dbClient
      .insert(chapter_assignments)
      .values(chunk)
      .onConflictDoNothing()
      .returning();
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

export async function claimIfUnassigned(
  id: number,
  userId: number,
  tx: DbTransaction
): Promise<{ claimed: boolean; record: ChapterAssignmentRecord | null }> {
  const [updated] = await tx
    .update(chapter_assignments)
    .set({
      assignedUserId: userId,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
    })
    .where(
      and(
        eq(chapter_assignments.id, id),
        isNull(chapter_assignments.assignedUserId),
        eq(chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED)
      )
    )
    .returning();

  return { claimed: !!updated, record: updated ?? null };
}

export async function submitPeerCheckIfEligible(
  id: number,
  userId: number,
  nextStatus: ChapterAssignmentStatus,
  submittedTime: Date,
  tx: DbTransaction
): Promise<ChapterAssignmentRecord | null> {
  const [updated] = await tx
    .update(chapter_assignments)
    .set({
      peerCheckerId: userId,
      status: nextStatus,
      submittedTime,
    })
    .where(
      and(
        eq(chapter_assignments.id, id),
        eq(chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK),
        ne(chapter_assignments.assignedUserId, userId),
        or(isNull(chapter_assignments.peerCheckerId), eq(chapter_assignments.peerCheckerId, userId))
      )
    )
    .returning();

  return updated ?? null;
}

/**
 * Marks a durable claim conflict for the losing claimant.
 * CAS: eligible when the row exists, is assigned to someone other than the
 * caller, and is not terminal (`complete`). On match, sets `hasClaimConflict`
 * and latches `claimConflictUserId` to the first loser (COALESCE — later
 * claimants do not overwrite). Does not change `assignedUserId` or
 * `peerCheckerId`. Returns null when the row is gone, unassigned, assigned to
 * the caller, or complete — callers must not treat that as durable conflict
 * success.
 */
export async function flagClaimConflict(
  id: number,
  claimConflictUserId: number,
  tx: DbTransaction
): Promise<ChapterAssignmentRecord | null> {
  const [updated] = await tx
    .update(chapter_assignments)
    .set({
      hasClaimConflict: true,
      claimConflictUserId: sql`COALESCE(${chapter_assignments.claimConflictUserId}, ${claimConflictUserId})`,
    })
    .where(
      and(
        eq(chapter_assignments.id, id),
        isNotNull(chapter_assignments.assignedUserId),
        ne(chapter_assignments.assignedUserId, claimConflictUserId),
        ne(chapter_assignments.status, CHAPTER_ASSIGNMENT_STATUS.COMPLETE)
      )
    )
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

export async function deleteByProjectUnitAndBooks(
  projectUnitId: number,
  bookIds: number[],
  tx?: DbTransaction
): Promise<void> {
  if (bookIds.length === 0) return;
  const conn = tx ?? db;
  await conn
    .delete(chapter_assignments)
    .where(
      and(
        eq(chapter_assignments.projectUnitId, projectUnitId),
        inArray(chapter_assignments.bookId, bookIds)
      )
    );
}

/** Batch status history (createdAt ASC NULLS LAST, id ASC). Resolver rejects any null createdAt. */
export async function findStatusHistoryByAssignmentIds(
  assignmentIds: number[],
  tx?: DbTransaction
): Promise<Map<number, StatusHistoryRow[]>> {
  const result = new Map<number, StatusHistoryRow[]>();
  if (assignmentIds.length === 0) return result;

  const conn = tx ?? db;
  const rows = await conn
    .select({
      id: chapter_assignment_status_history.id,
      chapterAssignmentId: chapter_assignment_status_history.chapterAssignmentId,
      status: chapter_assignment_status_history.status,
      createdAt: chapter_assignment_status_history.createdAt,
    })
    .from(chapter_assignment_status_history)
    .where(inArray(chapter_assignment_status_history.chapterAssignmentId, assignmentIds))
    .orderBy(
      chapter_assignment_status_history.chapterAssignmentId,
      sql`${chapter_assignment_status_history.createdAt} ASC NULLS LAST`,
      asc(chapter_assignment_status_history.id)
    );

  for (const id of assignmentIds) result.set(id, []);
  for (const row of rows) {
    result.get(row.chapterAssignmentId)?.push({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
    });
  }
  return result;
}

export async function insertStatusHistory(
  tx: DbTransaction,
  chapterAssignmentId: number,
  status: ChapterAssignmentStatus
): Promise<void> {
  await tx.insert(chapter_assignment_status_history).values({ chapterAssignmentId, status });
}

export async function insertManyStatusHistory(
  tx: DbTransaction,
  records: { chapterAssignmentId: number; status: ChapterAssignmentStatus }[]
): Promise<void> {
  if (records.length === 0) return;
  await tx.insert(chapter_assignment_status_history).values(records);
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

export async function findProjectIdByUnitId(
  unitId: number,
  tx?: DbTransaction
): Promise<number | null> {
  const executor = tx ?? db;
  const [row] = await executor
    .select({ projectId: project_units.projectId })
    .from(project_units)
    .where(eq(project_units.id, unitId))
    .limit(1);
  return row ? row.projectId : null;
}
