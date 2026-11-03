import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { NewChapterComment } from '@/db/draft-comments.schema';
import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import { chapter_comment_reactions, chapter_comments } from '@/db/draft-comments.schema';
import {
  bible_texts,
  chapter_assignments,
  pericope_verses,
  project_units,
  projects,
  roles,
  user_roles,
  users,
} from '@/db/schema';

import { matchPublicPericopeMembership } from './draft-comments.pericopes';

type Executor = typeof db | DbTransaction;

export async function findAssignmentContext(chapterAssignmentId: number, conn: Executor = db) {
  const [row] = await conn
    .select({
      assignmentId: chapter_assignments.id,
      projectId: projects.id,
      organizationId: projects.organization,
      projectUnitId: chapter_assignments.projectUnitId,
      bibleId: chapter_assignments.bibleId,
      bookId: chapter_assignments.bookId,
      chapterNumber: chapter_assignments.chapterNumber,
      pericopeSetId: projects.pericopeSetId,
    })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(project_units.id, chapter_assignments.projectUnitId))
    .innerJoin(projects, eq(projects.id, project_units.projectId))
    .where(eq(chapter_assignments.id, chapterAssignmentId))
    .limit(1);
  return row ?? null;
}

/**
 * Lock assignment + owning project for the short post-upload write.
 * Holds until tx end so project.pericope_set_id / assignment geometry cannot change
 * between revalidation and insert (READ COMMITTED SELECT→INSERT gap).
 */
export async function lockAssignmentWriteContext(chapterAssignmentId: number, tx: DbTransaction) {
  const [assignmentLock] = await tx
    .select({ id: chapter_assignments.id, projectUnitId: chapter_assignments.projectUnitId })
    .from(chapter_assignments)
    .where(eq(chapter_assignments.id, chapterAssignmentId))
    .limit(1)
    .for('update');
  if (!assignmentLock) return null;

  const [unit] = await tx
    .select({ projectId: project_units.projectId })
    .from(project_units)
    .where(eq(project_units.id, assignmentLock.projectUnitId))
    .limit(1)
    .for('update');
  if (!unit) return null;

  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, unit.projectId))
    .limit(1)
    .for('update');
  if (!project) return null;

  return findAssignmentContext(chapterAssignmentId, tx);
}

export async function findBibleTextById(bibleTextId: number, conn: Executor = db) {
  const [row] = await conn
    .select({
      id: bible_texts.id,
      bibleId: bible_texts.bibleId,
      bookId: bible_texts.bookId,
      chapterNumber: bible_texts.chapterNumber,
      verseNumber: bible_texts.verseNumber,
    })
    .from(bible_texts)
    .where(eq(bible_texts.id, bibleTextId))
    .limit(1);
  return row ?? null;
}

/** Lock verse source row for the remainder of the write transaction. */
export async function lockBibleTextById(bibleTextId: number, tx: DbTransaction) {
  const [row] = await tx
    .select({
      id: bible_texts.id,
      bibleId: bible_texts.bibleId,
      bookId: bible_texts.bookId,
      chapterNumber: bible_texts.chapterNumber,
      verseNumber: bible_texts.verseNumber,
    })
    .from(bible_texts)
    .where(eq(bible_texts.id, bibleTextId))
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function findPericopeMembership(
  pericopeSetId: number,
  bookId: number,
  chapterNumber: number,
  publicPericopeNumber: string,
  conn: Executor = db
) {
  // Load chapter-scoped rows, then match the public wire id (section_raw vs raw) —
  // never eq() against raw pericope_number alone (ambiguous for FCBH sections).
  const rows = await conn
    .select({
      pericopeSetId: pericope_verses.pericopeSetId,
      bookId: pericope_verses.bookId,
      chapterNumber: pericope_verses.chapterNumber,
      section: pericope_verses.section,
      pericopeNumber: pericope_verses.pericopeNumber,
      pericopeTitle: pericope_verses.pericopeTitle,
    })
    .from(pericope_verses)
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        eq(pericope_verses.bookId, bookId),
        eq(pericope_verses.chapterNumber, chapterNumber)
      )
    );
  return matchPublicPericopeMembership(rows, publicPericopeNumber);
}

/**
 * Serialize comment create with pericope_verses mutations on the same public identity.
 * Must match the advisory key in mark_chapter_comments_unconnected_for_pericope_verse_mutation.
 */
export async function lockPublicPericopeIdentity(
  pericopeSetId: number,
  bookId: number,
  chapterNumber: number,
  publicPericopeNumber: string,
  tx: DbTransaction
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(
      87201458,
      hashtext(${pericopeSetId}::text || '/' || ${bookId}::text || '/' || ${chapterNumber}::text || '/' || ${publicPericopeNumber})
    )`
  );
}

/**
 * Lock matching membership rows (public id) so DELETE/section UPDATE cannot slip past revalidation.
 *
 * Lock order MUST be row FOR UPDATE then advisory — matching the AFTER trigger on
 * pericope_verses, which already holds the mutated row before taking the same advisory.
 * Advisory-then-row deadlocks with that trigger (40P01 under two real PG backends).
 */
export async function lockPericopeMembership(
  pericopeSetId: number,
  bookId: number,
  chapterNumber: number,
  publicPericopeNumber: string,
  tx: DbTransaction
) {
  const rows = await tx
    .select({
      pericopeSetId: pericope_verses.pericopeSetId,
      bookId: pericope_verses.bookId,
      chapterNumber: pericope_verses.chapterNumber,
      section: pericope_verses.section,
      pericopeNumber: pericope_verses.pericopeNumber,
      pericopeTitle: pericope_verses.pericopeTitle,
    })
    .from(pericope_verses)
    .where(
      and(
        eq(pericope_verses.pericopeSetId, pericopeSetId),
        eq(pericope_verses.bookId, bookId),
        eq(pericope_verses.chapterNumber, chapterNumber),
        sql`(
          (${pericope_verses.section} IS NULL AND ${pericope_verses.pericopeNumber} = ${publicPericopeNumber})
          OR (
            ${pericope_verses.section} IS NOT NULL
            AND (${pericope_verses.section}::text || '_' || ${pericope_verses.pericopeNumber}) = ${publicPericopeNumber}
          )
        )`
      )
    )
    .orderBy(asc(pericope_verses.id))
    .for('update');
  // Advisory after row locks: serializes with trigger + closes insert phantoms when
  // membership was empty at FOR UPDATE (concurrent INSERT waits on advisory).
  await lockPublicPericopeIdentity(pericopeSetId, bookId, chapterNumber, publicPericopeNumber, tx);
  return matchPublicPericopeMembership(rows, publicPericopeNumber);
}

export async function insertComment(values: NewChapterComment, conn: Executor = db) {
  const [row] = await conn.insert(chapter_comments).values(values).returning();
  return row!;
}

export async function findCommentById(commentId: number, conn: Executor = db) {
  const [row] = await conn
    .select()
    .from(chapter_comments)
    .where(eq(chapter_comments.id, commentId))
    .limit(1);
  return row ?? null;
}

/** Lock root comment so connectionState/anchor cannot change between revalidation and insert. */
export async function lockCommentById(commentId: number, tx: DbTransaction) {
  const [row] = await tx
    .select()
    .from(chapter_comments)
    .where(eq(chapter_comments.id, commentId))
    .limit(1)
    .for('update');
  return row ?? null;
}

export async function listCommentsForAssignment(chapterAssignmentId: number, conn: Executor = db) {
  return conn
    .select()
    .from(chapter_comments)
    .where(eq(chapter_comments.chapterAssignmentId, chapterAssignmentId))
    .orderBy(asc(chapter_comments.createdAt), asc(chapter_comments.id));
}

export async function findAuthorDisplay(userId: number, conn: Executor = db) {
  const [row] = await conn
    .select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      username: users.username,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row ?? null;
}

/** Project-scoped role display names for comment authors (not role-label auth). */
export async function findProjectRoleDisplays(
  projectId: number,
  userIds: number[],
  conn: Executor = db
): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (userIds.length === 0) return out;
  const rows = await conn
    .select({
      userId: user_roles.userId,
      roleName: roles.name,
    })
    .from(user_roles)
    .innerJoin(roles, eq(roles.id, user_roles.roleId))
    .where(and(eq(user_roles.projectId, projectId), inArray(user_roles.userId, userIds)));
  for (const row of rows) {
    if (!out.has(row.userId)) out.set(row.userId, row.roleName);
  }
  return out;
}

export async function countCommentsForAssignment(chapterAssignmentId: number, conn: Executor = db) {
  const [row] = await conn
    .select({ value: count() })
    .from(chapter_comments)
    .where(eq(chapter_comments.chapterAssignmentId, chapterAssignmentId));
  return Number(row?.value ?? 0);
}

export async function userHasAuthoredComment(
  chapterAssignmentId: number,
  userId: number,
  conn: Executor = db
) {
  const [row] = await conn
    .select({ id: chapter_comments.id })
    .from(chapter_comments)
    .where(
      and(
        eq(chapter_comments.chapterAssignmentId, chapterAssignmentId),
        eq(chapter_comments.authorUserId, userId)
      )
    )
    .limit(1);
  return row != null;
}

export async function listReactionsForComments(commentIds: number[], conn: Executor = db) {
  if (commentIds.length === 0) return [];
  return conn
    .select()
    .from(chapter_comment_reactions)
    .where(inArray(chapter_comment_reactions.commentId, commentIds))
    .orderBy(
      asc(chapter_comment_reactions.commentId),
      asc(chapter_comment_reactions.createdAt),
      asc(chapter_comment_reactions.id)
    );
}

/**
 * Atomic set / replace / same-emoji clear via DB function + advisory xact lock.
 * Returns the active emoji, or null when cleared.
 */
export async function atomicSetReaction(
  commentId: number,
  userId: number,
  emoji: string,
  conn: Executor = db
): Promise<string | null> {
  const res = await conn.execute(
    sql`SELECT set_chapter_comment_reaction(${commentId}, ${userId}, ${emoji}) AS emoji`
  );
  const rows = Array.isArray(res)
    ? res
    : ((res as { rows?: Array<{ emoji: string | null }> }).rows ?? []);
  const row = rows[0] as { emoji: string | null } | undefined;
  return row?.emoji ?? null;
}

export async function deleteReaction(commentId: number, userId: number, conn: Executor = db) {
  await conn
    .delete(chapter_comment_reactions)
    .where(
      and(
        eq(chapter_comment_reactions.commentId, commentId),
        eq(chapter_comment_reactions.userId, userId)
      )
    );
}
