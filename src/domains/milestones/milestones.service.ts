import { inArray } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { books } from '@/db/schema';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectsRepo from '@/domains/projects/projects.repository';
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
      await projectsRepo.lockProjectById(projectId, tx);

      const milestone = await repo.insertMilestoneRecord(
        projectId,
        {
          name: input.name,
          type: input.type,
          status: input.status,
        },
        tx
      );

      const existingAssignments = await repo.getExistingBookAssignmentsForProject(
        projectId,
        input.bookIds,
        tx
      );
      const activeAssignments = existingAssignments.filter((a) => !a.deletedAt);
      if (activeAssignments.length > 0) {
        throw new Error('BOOKS_ALREADY_ASSIGNED');
      }

      const softDeletedAssignments = existingAssignments.filter((a) => a.deletedAt);
      const softDeletedBookIds = new Set(softDeletedAssignments.map((a) => a.bookId));

      const newBooks = input.bookIds.filter((id) => !softDeletedBookIds.has(id));

      if (newBooks.length > 0) {
        const links = newBooks.map((bookId) => ({
          projectUnitId: milestone.id,
          bibleId: sourceBibleId,
          bookId,
        }));
        await repo.insertBibleBookLinks(links, tx);
      }

      if (softDeletedAssignments.length > 0) {
        await Promise.all(
          softDeletedAssignments.map((assignment) =>
            repo.moveBookToMilestone(assignment.bookId, assignment.projectUnitId, milestone.id, tx)
          )
        );
      }

      let booksToIngest: number[] = [];
      if (newBooks.length > 0) {
        const chapterAssignmentsResult =
          await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
            milestone.id,
            sourceBibleId,
            newBooks,
            tx
          );

        if (!chapterAssignmentsResult.ok) {
          throw new Error(chapterAssignmentsResult.error.code);
        }

        const assignedBookIds = new Set(chapterAssignmentsResult.data.map((a) => a.bookId));
        booksToIngest = newBooks.filter((id) => !assignedBookIds.has(id));
      }

      return { milestone, booksToIngest };
    });

    if (result.booksToIngest.length > 0) {
      const bookRecords = await db.query.books.findMany({
        where: inArray(books.id, result.booksToIngest),
        columns: { code: true },
      });

      let boss;
      try {
        boss = await getQueue();
      } catch (e) {
        logger.error({
          message: 'Failed to get queue for DBL ingest',
          context: { bibleId: sourceBibleId, error: e },
        });
      }
      if (boss) {
        for (const book of bookRecords) {
          try {
            await boss.send(
              QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
              {
                bibleId: sourceBibleId,
                bookCodes: [book.code],
                projectUnitId: result.milestone.id,
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
      logger.info({
        message: 'No valid books found for Bible, skipping text ingestion',
        context: { bibleId: sourceBibleId },
      });
    }

    const enrichedMilestone = await repo.getByIdForProject(projectId, result.milestone.id);
    if (!enrichedMilestone) return err(ErrorCode.NOT_FOUND);

    return ok(enrichedMilestone);
  } catch (error: any) {
    if (error.message === 'BOOKS_ALREADY_ASSIGNED') return err(ErrorCode.VALIDATION_ERROR);
    if (Object.values(ErrorCode).includes(error.message as ErrorCode)) return err(error.message as ErrorCode);
    logger.error({
      cause: error,
      message: 'Failed to create milestone',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function listMilestonesForProject(projectId: number): Promise<Result<MilestoneRow[]>> {
  try {
    const milestones = await repo.listByProjectId(projectId);
    return ok(milestones);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to list milestones', context: { projectId } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getMilestone(
  projectId: number,
  milestoneId: number
): Promise<Result<MilestoneRow>> {
  try {
    const milestone = await repo.getByIdForProject(projectId, milestoneId);
    if (!milestone) return err(ErrorCode.NOT_FOUND);
    return ok(milestone);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get milestone', context: { milestoneId } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateMilestone(
  projectId: number,
  milestoneId: number,
  input: UpdateMilestoneInput,
  sourceBibleId: number | null
): Promise<Result<MilestoneRow>> {
  try {
    const existing = await repo.getByIdForProject(projectId, milestoneId);
    if (!existing) return err(ErrorCode.NOT_FOUND);

    const { moveBooks, addBooks, removeBooks, ...updates } = input;

    let enqueueBooksForIngestion: { id: number; code: string }[] = [];

    await db.transaction(async (tx) => {
      await projectsRepo.lockProjectById(projectId, tx);

      await repo.updateMilestoneRecord(milestoneId, updates, tx);

      if (moveBooks && moveBooks.length > 0) {
        // Authorization: verify all target milestones belong to the same project
        const sourceBookIds = new Set(existing.bookIds);
        for (const move of moveBooks) {
          if (!sourceBookIds.has(move.bookId)) {
            throw new Error('INVALID_BIBLE_BOOKS');
          }
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

      if (addBooks && addBooks.length > 0 && sourceBibleId) {
        const validBookIds = await repo.getValidBookIdsForBible(sourceBibleId, addBooks, tx);
        if (validBookIds.length !== addBooks.length) {
          throw new Error('INVALID_BIBLE_BOOKS');
        }

        const existingAssignments = await repo.getExistingBookAssignmentsForProject(
          projectId,
          addBooks,
          tx
        );
        const activeAssignments = existingAssignments.filter((a) => !a.deletedAt);
        if (activeAssignments.length > 0) {
          throw new Error('BOOKS_ALREADY_ASSIGNED');
        }

        const softDeletedAssignments = existingAssignments.filter((a) => a.deletedAt);
        const softDeletedBookIds = new Set(softDeletedAssignments.map((a) => a.bookId));

        // Restore soft-deleted books by moving them to the current milestone
        if (softDeletedAssignments.length > 0) {
          await Promise.all(
            softDeletedAssignments.map((assignment) =>
              repo.moveBookToMilestone(assignment.bookId, assignment.projectUnitId, milestoneId, tx)
            )
          );
        }

        const trulyNewBooks = addBooks.filter((id) => !softDeletedBookIds.has(id));

        if (trulyNewBooks.length > 0) {
          const links = trulyNewBooks.map((bookId) => ({
            projectUnitId: milestoneId,
            bibleId: sourceBibleId,
            bookId,
          }));
          await repo.insertBibleBookLinks(links, tx);

          const chapterAssignmentsResult =
            await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
              milestoneId,
              sourceBibleId,
              trulyNewBooks,
              tx
            );
          if (!chapterAssignmentsResult.ok) {
            throw new Error(chapterAssignmentsResult.error.code);
          }

          const assignedBookIds = new Set(chapterAssignmentsResult.data.map((a) => a.bookId));
          const missingBookIds = trulyNewBooks.filter((id) => !assignedBookIds.has(id));
          if (missingBookIds.length > 0) {
            enqueueBooksForIngestion = await db.query.books.findMany({
              where: inArray(books.id, missingBookIds),
              columns: { code: true, id: true },
            });
          }
        }
      }

      if (removeBooks && removeBooks.length > 0) {
        // Soft delete the book links, retaining translated data and chapter assignments
        await repo.deleteBibleBookLinks(milestoneId, removeBooks, tx);
      }
    });

    if (enqueueBooksForIngestion.length > 0 && sourceBibleId) {
      let boss;
      try {
        boss = await getQueue();
      } catch (e) {
        logger.error({ message: 'Failed to get queue for DBL ingest', context: { error: e } });
      }
      if (boss) {
        for (const book of enqueueBooksForIngestion) {
          try {
            await boss.send(
              QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
              {
                bibleId: sourceBibleId,
                bookCodes: [book.code],
                projectUnitId: milestoneId,
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
    }

    const updated = await repo.getByIdForProject(projectId, milestoneId);
    if (!updated) return err(ErrorCode.NOT_FOUND);
    return ok(updated);
  } catch (error: any) {
    if (error.message === 'CROSS_PROJECT_MOVE') return err(ErrorCode.FORBIDDEN);
    if (error.message === 'INVALID_BIBLE_BOOKS') return err(ErrorCode.INVALID_BIBLE_BOOKS);
    if (error.message === 'BOOKS_ALREADY_ASSIGNED') return err(ErrorCode.VALIDATION_ERROR);
    if (Object.values(ErrorCode).includes(error.message as ErrorCode)) return err(error.message as ErrorCode);
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

    await db.transaction(async (tx) => {
      const hasBooks = await repo.hasAnyBooks(milestoneId, tx);
      if (hasBooks) {
        throw new Error('HAS_BOOKS');
      }
      await repo.deleteMilestoneRecord(milestoneId, tx);
    });

    return ok(undefined);
  } catch (error: any) {
    if (error.message === 'HAS_BOOKS') return err(ErrorCode.VALIDATION_ERROR);
    logger.error({
      cause: error,
      message: 'Failed to delete milestone',
      context: { milestoneId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
