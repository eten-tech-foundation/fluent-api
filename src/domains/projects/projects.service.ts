import { eq } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { bible_books, bible_texts, books, pericope_sets } from '@/db/schema';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateProjectServiceInput, Project, UpdateProjectInput } from './projects.types';

import * as repo from './projects.repository';

export function getProjectsByOrganization(organizationId: number) {
  return repo.getByOrganization(organizationId);
}

export async function getProjectsByUserId(userId: number, updatedAfter?: Date) {
  return repo.getByUserId(userId, updatedAfter);
}

export function getProjectById(id: number) {
  return repo.getById(id);
}

export function deleteProject(id: number) {
  return repo.remove(id);
}

export function getProjectIdByUnitId(projectUnitId: number) {
  return repo.getProjectIdByUnitId(projectUnitId);
}

// This function is used to update the last activity timestamp for a project when a chapter assignment is created or updated. It retrieves the project ID associated with the given project unit ID and then updates the last activity timestamp in the database.
export async function touchProjectActivity(
  projectUnitId: number,
  tx: DbTransaction
): Promise<void> {
  const result = await repo.getProjectIdByUnitId(projectUnitId, tx);

  if (!result.ok) {
    logger.error({
      message: 'Failed to resolve project for last-activity update',
      context: { projectUnitId, error: result.error },
    });
    throw new Error(`Failed to resolve project for activity update: ${String(result.error)}`);
  }

  await repo.touchLastActivity(result.data.projectId, tx);
}

export async function createProject(input: CreateProjectServiceInput): Promise<Result<Project>> {
  try {
    const validBookIds = await repo.getValidBookIdsForBible(input.bibleId);
    const hasInvalidBooks = input.bookId.some((id) => !validBookIds.includes(id));

    if (hasInvalidBooks) {
      logger.error({
        message: 'Invalid bible books requested',
        context: { requestedBooks: input.bookId, bibleId: input.bibleId },
      });
      return err(ErrorCode.INVALID_BIBLE_BOOKS);
    }

    if (input.pericopeSetId != null) {
      const [exists] = await db
        .select({ id: pericope_sets.id })
        .from(pericope_sets)
        .where(eq(pericope_sets.id, input.pericopeSetId))
        .limit(1);
      if (!exists) {
        return err(ErrorCode.PERICOPE_SET_NOT_FOUND);
      }
    }

    const result = await db.transaction(async (tx) => {
      const { bibleId, bookId, projectUnitStatus = 'not_started', ...projectData } = input;

      const project = await repo.insertProjectRecord(
        { ...projectData, status: 'not_assigned' },
        tx
      );

      const projectUnit = await repo.insertProjectUnitRecord(
        { projectId: project.id, status: projectUnitStatus },
        tx
      );

      const bibleBookEntries = bookId.map((id) => ({
        projectUnitId: projectUnit.id,
        bibleId,
        bookId: id,
      }));
      await repo.insertBibleBookLinks(bibleBookEntries, tx);

      const assignmentsResult =
        await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
          projectUnit.id,
          bibleId,
          bookId,
          tx
        );

      if (!assignmentsResult.ok) {
        throw new Error(assignmentsResult.error.message || 'Failed to create chapter assignments');
      }

      return ok(project);
    });

    // Enqueue the on-demand text ingestion job
    if (result.ok) {
      try {
        const queue = await getQueue();

        // Detect which books have already been ingested for this Bible
        const ingestedBooks = await db
          .selectDistinct({ bookId: bible_texts.bookId })
          .from(bible_texts)
          .where(eq(bible_texts.bibleId, input.bibleId));
        const ingestedBookIds = ingestedBooks.map((r) => r.bookId);

        // 1. Get the requested books for the priority queue
        const dbBooks = await db.query.books.findMany({
          where: (books, { inArray }) => inArray(books.id, input.bookId),
        });
        const priorityBookCodes = dbBooks
          .filter((b) => !ingestedBookIds.includes(b.id))
          .map((b) => b.code);

        // 2. Get all remaining books in the bible for the background queue
        const allBibleBooks = await db
          .select({ code: books.code, id: books.id })
          .from(bible_books)
          .innerJoin(books, eq(bible_books.bookId, books.id))
          .where(eq(bible_books.bibleId, input.bibleId));

        // Filter out books already in the priority queue or already ingested
        const remainingBookCodes = allBibleBooks
          .filter((b) => !priorityBookCodes.includes(b.code) && !ingestedBookIds.includes(b.id))
          .map((b) => b.code);

        // Enqueue Priority Job (Higher urgency)
        if (priorityBookCodes.length > 0) {
          await queue.send(
            QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
            {
              projectId: result.data.id,
              bibleId: input.bibleId,
              bookCodes: priorityBookCodes,
            },
            { priority: 10 }
          ); // pg-boss priority (higher is processed first)
          logger.info('Enqueued PRIORITY text ingestion job', {
            projectId: result.data.id,
            bookCount: priorityBookCodes.length,
          });
        }

        // Enqueue Background Job
        if (remainingBookCodes.length > 0) {
          await queue.send(QUEUE_NAMES.DBL_INGEST_TEXT, {
            projectId: result.data.id,
            bibleId: input.bibleId,
            bookCodes: remainingBookCodes,
          });
          logger.info('Enqueued BACKGROUND text ingestion job', {
            projectId: result.data.id,
            bookCount: remainingBookCodes.length,
          });
        }
      } catch (error) {
        logger.error('Failed to enqueue text ingestion job', { error });
      }
    }

    return result;
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create project',
      context: {
        organization: input.organization,
        bibleId: input.bibleId,
        bookId: input.bookId,
      },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateProject(
  id: number,
  input: UpdateProjectInput
): Promise<Result<Project>> {
  try {
    if (input.pericopeSetId != null) {
      const [exists] = await db
        .select({ id: pericope_sets.id })
        .from(pericope_sets)
        .where(eq(pericope_sets.id, input.pericopeSetId))
        .limit(1);
      if (!exists) {
        return err(ErrorCode.PERICOPE_SET_NOT_FOUND);
      }
    }

    return await db.transaction(async (tx) => {
      const { bibleId, bookId, projectUnitStatus, ...projectData } = input;

      const updatedProject = await repo.updateProjectRecord(id, projectData, tx);

      if (!updatedProject) {
        return err(ErrorCode.PROJECT_NOT_FOUND);
      }

      if (projectUnitStatus !== undefined) {
        await repo.updateProjectUnitStatusByProjectId(id, projectUnitStatus, tx);
      }

      return ok(updatedProject);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update project',
      context: { projectId: id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
