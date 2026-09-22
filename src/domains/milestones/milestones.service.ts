import { inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books } from '@/db/schema';
import * as chapterAssignmentsRepo from '@/domains/chapter-assignments/chapter-assignments.repository';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateMilestoneInput, MilestoneRow, UpdateMilestoneInput } from './milestones.types';

import * as repo from './milestones.repository';

export async function createMilestone(
  projectId: number,
  sourceBibleId: number,
  input: CreateMilestoneInput
): Promise<Result<MilestoneRow>> {
  try {
    const validBookIds = await repo.getValidBookIdsForBible(sourceBibleId, input.bookIds);
    if (validBookIds.length !== input.bookIds.length) {
      return err(ErrorCode.INVALID_BIBLE_BOOKS);
    }

    const result = await db.transaction(async (tx) => {
      const milestone = await repo.insertMilestoneRecord(
        projectId,
        {
          name: input.name,
          type: input.type,
          status: input.status,
        },
        tx
      );

      const links = input.bookIds.map((bookId) => ({
        projectUnitId: milestone.id,
        bibleId: sourceBibleId,
        bookId,
      }));
      await repo.insertBibleBookLinks(links, tx);

      const chapterAssignmentsResult =
        await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
          milestone.id,
          sourceBibleId,
          input.bookIds,
          tx
        );

      if (!chapterAssignmentsResult.ok) {
        throw new Error('Failed to create chapter assignments');
      }

      return milestone;
    });

    if (validBookIds.length > 0) {
      const bookRecords = await db.query.books.findMany({
        where: inArray(books.id, validBookIds),
        columns: { code: true },
      });

      const boss = await getQueue();
      if (boss) {
        for (const book of bookRecords) {
          try {
            await boss.send(
              QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
              {
                bibleId: sourceBibleId,
                bookCode: book.code,
                projectUnitId: result.id,
              },
              { priority: 10 }
            );
          } catch (e) {
            logger.error({
              message: 'Failed to enqueue DBL ingest job',
              context: { bibleId: sourceBibleId, bookCode: book.code, error: e },
            });
          }
        }
      }
    } else {
      logger.warn({
        message: 'No valid books found for Bible, skipping text ingestion',
        context: { bibleId: sourceBibleId },
      });
    }

    const enrichedMilestone = await repo.getByIdForProject(projectId, result.id);
    if (!enrichedMilestone) return err(ErrorCode.NOT_FOUND);

    return ok(enrichedMilestone);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create milestone',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function listMilestonesForProject(projectId: number): Promise<Result<MilestoneRow[]>> {
  const milestones = await repo.listByProjectId(projectId);
  return ok(milestones);
}

export async function listMilestonesForProjects(
  projectIds: number[]
): Promise<Result<MilestoneRow[]>> {
  const milestones = await repo.listByProjectIds(projectIds);
  return ok(milestones);
}

export async function getMilestone(
  projectId: number,
  milestoneId: number
): Promise<Result<MilestoneRow>> {
  const milestone = await repo.getByIdForProject(projectId, milestoneId);
  if (!milestone) return err(ErrorCode.NOT_FOUND);
  return ok(milestone);
}

export async function updateMilestone(
  projectId: number,
  milestoneId: number,
  input: UpdateMilestoneInput
): Promise<Result<MilestoneRow>> {
  try {
    const existing = await repo.getByIdForProject(projectId, milestoneId);
    if (!existing) return err(ErrorCode.NOT_FOUND);

    const { moveBooks, addBooks, removeBooks, bibleId, ...updates } = input;

    if (addBooks && addBooks.length > 0 && !bibleId) {
      return err(ErrorCode.VALIDATION_ERROR);
    }

    await db.transaction(async (tx) => {
      await repo.updateMilestoneRecord(milestoneId, updates, tx);

      if (moveBooks && moveBooks.length > 0) {
        // Authorization: verify all target milestones belong to the same project
        for (const move of moveBooks) {
          const targetMilestone = await repo.getMilestoneById(move.targetMilestoneId, tx);
          if (!targetMilestone || targetMilestone.projectId !== projectId) {
            throw new Error('CROSS_PROJECT_MOVE');
          }
        }

        await Promise.all(
          moveBooks.map((move) =>
            repo.moveBookToMilestone(move.bookId, milestoneId, move.targetMilestoneId, tx)
          )
        );
      }

      if (addBooks && addBooks.length > 0 && bibleId) {
        const validBookIds = await repo.getValidBookIdsForBible(bibleId, addBooks);
        if (validBookIds.length !== addBooks.length) {
          throw new Error('Invalid bible books');
        }

        const links = addBooks.map((bookId) => ({
          projectUnitId: milestoneId,
          bibleId,
          bookId,
        }));
        await repo.insertBibleBookLinks(links, tx);

        const chapterAssignmentsResult =
          await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
            milestoneId,
            bibleId,
            addBooks,
            tx
          );
        if (!chapterAssignmentsResult.ok) {
          throw new Error('Failed to create chapter assignments');
        }
      }

      if (removeBooks && removeBooks.length > 0) {
        // Cascade: also remove translated data (verses, audio) for these books
        await repo.deleteTranslatedDataForBooks(milestoneId, removeBooks, tx);
        await repo.deleteBibleBookLinks(milestoneId, removeBooks, tx);
        await chapterAssignmentsRepo.deleteByProjectUnitAndBooks(milestoneId, removeBooks, tx);
      }
    });

    const updated = await repo.getByIdForProject(projectId, milestoneId);
    if (!updated) return err(ErrorCode.NOT_FOUND);
    return ok(updated);
  } catch (error: any) {
    if (error.message === 'CROSS_PROJECT_MOVE') return err(ErrorCode.FORBIDDEN);
    logger.error({
      cause: error,
      message: 'Failed to update milestone',
      context: { milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteMilestone(
  projectId: number,
  milestoneId: number
): Promise<Result<void>> {
  try {
    const existing = await repo.getByIdForProject(projectId, milestoneId);
    if (!existing) return err(ErrorCode.NOT_FOUND);

    await repo.deleteMilestoneRecord(milestoneId);
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete milestone',
      context: { milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
