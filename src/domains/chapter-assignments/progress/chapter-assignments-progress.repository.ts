import { and, eq, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Provider } from '@/domains/bible-provider-resources/bible-provider-resources.types';
import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_provider_resources,
  bible_texts,
  bibles,
  books,
  chapter_assignments,
  languages,
  project_unit_bible_books,
  project_units,
  projects,
  translated_verses,
  users,
} from '@/db/schema';
import { bibleKey } from '@/domains/bible-provider-resources/bible-provider-resources.identity';
import { VERSE_AUDIO_CONFLICT_STATUS } from '@/domains/verse-audio/verse-audio.types';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ChapterAssignmentProgressInfo } from '../chapter-assignments.types';
import type { ChapterAssignmentsProgressFilters } from './chapter-assignments-progress.types';

type AssignmentProgressRow = Omit<
  ChapterAssignmentProgressInfo,
  'textBibleKey' | 'selectedRecordingKey' | 'stageEnteredAt'
> & {
  textBibleProvider: Provider;
  textBibleExternalId: string | null;
  selectedRecordingId: number | null;
  selectedRecordingProvider: Provider | null;
  selectedRecordingExternalId: string | null;
};

type AssignmentProgressWithoutStageEnteredAt = Omit<
  ChapterAssignmentProgressInfo,
  'stageEnteredAt'
>;

function toAssignmentProgressInfo({
  textBibleProvider,
  textBibleExternalId,
  selectedRecordingId,
  selectedRecordingProvider,
  selectedRecordingExternalId,
  ...row
}: AssignmentProgressRow): AssignmentProgressWithoutStageEnteredAt {
  return {
    ...row,
    textBibleKey:
      textBibleExternalId === null
        ? null
        : bibleKey({ provider: textBibleProvider, externalId: textBibleExternalId }),
    selectedRecordingKey:
      selectedRecordingId === null ||
      selectedRecordingProvider === null ||
      selectedRecordingExternalId === null
        ? null
        : bibleKey({
            provider: selectedRecordingProvider,
            externalId: selectedRecordingExternalId,
          }),
  };
}

/**
 * EXISTS subquery for assignment progress: true when any verse-audio unit in
 * this assignment's bible/book/chapter is conflicted. Scoping by
 * `chapter_assignments.bibleId` (not book/chapter alone) is what keeps a
 * conflict in another Bible from lighting up the rollup.
 */
export function hasConflictRollupSql() {
  return sql<boolean>`EXISTS (
          SELECT 1
          FROM verse_audio_recordings var
          INNER JOIN bible_texts bt ON bt.id = var.bible_text_id
          WHERE var.project_unit_id = ${chapter_assignments.projectUnitId}
            AND bt.bible_id = ${chapter_assignments.bibleId}
            AND bt.book_id = ${chapter_assignments.bookId}
            AND bt.chapter_number = ${chapter_assignments.chapterNumber}
            AND var.conflict_status = ${VERSE_AUDIO_CONFLICT_STATUS.CONFLICT}
        )`;
}

export async function findAssignmentsProgress(
  filters: ChapterAssignmentsProgressFilters,
  tx?: DbTransaction
): Promise<Result<AssignmentProgressWithoutStageEnteredAt[]>> {
  try {
    const conn = tx ?? db;
    const assignedUser = alias(users, 'assignedUser');
    const peerChecker = alias(users, 'peerChecker');
    const sourceLang = alias(languages, 'sourceLang');
    const targetLang = alias(languages, 'targetLang');
    const recording = alias(bible_provider_resources, 'recording');

    const baseQuery = conn
      .select({
        assignmentId: chapter_assignments.id,
        projectId: projects.id,
        projectName: projects.name,
        projectUnitId: chapter_assignments.projectUnitId,
        bibleId: chapter_assignments.bibleId,
        bibleName: bibles.name,
        ttsLicenseStatus: sql<
          'allowed' | 'forbidden' | 'unknown'
        >`coalesce(${bible_provider_resources.ttsLicenseStatus}, 'unknown')`,
        textBibleProvider: bibles.provider,
        textBibleExternalId: bibles.externalId,
        selectedRecordingId: recording.id,
        selectedRecordingProvider: recording.provider,
        selectedRecordingExternalId: recording.externalId,
        bookId: chapter_assignments.bookId,
        bookCode: books.code,
        bookNameEng: books.eng_display_name,
        chapterNumber: chapter_assignments.chapterNumber,
        status: chapter_assignments.status,
        targetLanguage: targetLang.langName,
        // ISO 639-3 code consumed by the repeated-words check as greek-room's
        // lang_code (whitelist is keyed on the code). See phase-04 BUG #2.
        targetLangCode: targetLang.langCodeIso6393,
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
        isAiEnabled: chapter_assignments.isAiEnabled,
        hasClaimConflict: chapter_assignments.hasClaimConflict,
        claimConflictUserId: chapter_assignments.claimConflictUserId,
        hasConflict: hasConflictRollupSql().mapWith(Boolean),
      })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .innerJoin(
        project_unit_bible_books,
        and(
          eq(project_unit_bible_books.projectUnitId, chapter_assignments.projectUnitId),
          eq(project_unit_bible_books.bookId, chapter_assignments.bookId)
        )
      )
      .innerJoin(projects, eq(project_units.projectId, projects.id))
      .innerJoin(books, eq(chapter_assignments.bookId, books.id))
      .innerJoin(bibles, eq(bibles.id, chapter_assignments.bibleId))
      // `bibles.provider` deliberately remains the narrower DBL text-ingest enum,
      // while provider resources cover every playback identity. PostgreSQL cannot
      // compare those enum types directly, so this relational join casts to text.
      // Consolidating the broader provider vocabulary is deferred maintenance.
      .leftJoin(
        bible_provider_resources,
        and(
          sql`${bibles.provider}::text = ${bible_provider_resources.provider}::text`,
          eq(bibles.externalId, bible_provider_resources.externalId)
        )
      )
      .leftJoin(recording, eq(bibles.audioResourceId, recording.id))
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

    const conditions = [isNull(project_unit_bible_books.deletedAt)];
    if (filters.projectId !== undefined) {
      conditions.push(eq(project_units.projectId, filters.projectId));
    }
    if (filters.orgId !== undefined) {
      conditions.push(eq(projects.organization, filters.orgId));
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

    const rows = await baseQuery
      .where(and(...conditions))
      .groupBy(
        chapter_assignments.id,
        projects.id,
        projects.name,
        bibles.id,
        bibles.name,
        bible_provider_resources.id,
        recording.id,
        targetLang.langName,
        targetLang.langCodeIso6393,
        sourceLang.langCodeIso6393,
        books.code,
        books.eng_display_name,
        assignedUser.username,
        peerChecker.username
      )
      .orderBy(projects.name, books.eng_display_name, chapter_assignments.chapterNumber);

    return ok(rows.map(toAssignmentProgressInfo));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find assignments progress',
      context: { filters },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
