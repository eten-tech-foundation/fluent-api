import { inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books } from '@/db/schema';
import * as chapterAssignmentsRepo from '@/domains/chapter-assignments/chapter-assignments.repository';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateMilestoneInput, Milestone, UpdateMilestoneInput } from './milestones.types';

import * as repo from './milestones.repository';

export async function createMilestone(
  projectId: number,
  input: CreateMilestoneInput
): Promise<Result<Milestone>> {
  try {
    const validBookIds = await repo.getValidBookIdsForBible(input.bibleId, input.bookIds);
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
        bibleId: input.bibleId,
        bookId,
      }));
      await repo.insertBibleBookLinks(links, tx);

      const chapterAssignmentsResult =
        await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
          milestone.id,
          input.bibleId,
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
            await boss.send(QUEUE_NAMES.DBL_INGEST_TEXT, {
              bibleId: input.bibleId,
              bookCode: book.code,
            });
          } catch (e) {
            logger.error({
              message: 'Failed to enqueue DBL ingest job',
              context: { bibleId: input.bibleId, bookCode: book.code, error: e },
            });
          }
        }
      }
    } else {
      logger.warn({
        message: 'No valid books found for Bible, skipping text ingestion',
        context: { bibleId: input.bibleId },
      });
    }

    return ok(result);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create milestone',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getMilestones(projectId: number): Promise<Result<Milestone[]>> {
  const milestones = await repo.getMilestonesByProjectId(projectId);
  return ok(milestones);
}

export async function getMilestone(id: number): Promise<Result<Milestone>> {
  const milestone = await repo.getMilestoneById(id);
  if (!milestone) return err(ErrorCode.NOT_FOUND);
  return ok(milestone);
}

export async function updateMilestone(
  id: number,
  input: UpdateMilestoneInput
): Promise<Result<Milestone>> {
  try {
    const { moveBooks, addBooks, removeBooks, bibleId, ...updates } = input;

    if (addBooks && addBooks.length > 0 && !bibleId) {
      return err(ErrorCode.VALIDATION_ERROR);
    }

    const result = await db.transaction(async (tx) => {
      const milestone = await repo.updateMilestoneRecord(id, updates, tx);
      if (!milestone) throw new Error('MILESTONE_NOT_FOUND');

      if (moveBooks && moveBooks.length > 0) {
        await Promise.all(
          moveBooks.map((move) =>
            repo.moveBookToMilestone(move.bookId, id, move.targetMilestoneId, tx)
          )
        );
      }

      if (addBooks && addBooks.length > 0 && bibleId) {
        const validBookIds = await repo.getValidBookIdsForBible(bibleId, addBooks);
        if (validBookIds.length !== addBooks.length) {
          throw new Error('Invalid bible books');
        }

        const links = addBooks.map((bookId) => ({
          projectUnitId: id,
          bibleId,
          bookId,
        }));
        await repo.insertBibleBookLinks(links, tx);

        const chapterAssignmentsResult =
          await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
            id,
            bibleId,
            addBooks,
            tx
          );
        if (!chapterAssignmentsResult.ok) {
          throw new Error('Failed to create chapter assignments');
        }
      }

      if (removeBooks && removeBooks.length > 0) {
        await repo.deleteBibleBookLinks(id, removeBooks, tx);
        await chapterAssignmentsRepo.deleteByProjectUnitAndBooks(id, removeBooks, tx);
      }

      return milestone;
    });

    return ok(result);
  } catch (error: any) {
    if (error.message === 'MILESTONE_NOT_FOUND') return err(ErrorCode.NOT_FOUND);
    logger.error({
      cause: error,
      message: 'Failed to update milestone',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteMilestone(id: number): Promise<Result<void>> {
  try {
    await repo.deleteMilestoneRecord(id);
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to delete milestone',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
