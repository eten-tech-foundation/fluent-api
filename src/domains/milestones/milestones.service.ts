import { eq } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { bible_texts } from '@/db/schema';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectsRepo from '@/domains/projects/projects.repository';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateMilestoneInput, MilestoneRow, UpdateMilestoneInput } from './milestones.types';

import * as repo from './milestones.repository';

export function listMilestonesForProject(projectId: number) {
  return repo.listByProjectId(projectId);
}

export function listMilestonesForProjects(projectIds: number[]) {
  return repo.listByProjectIds(projectIds);
}

export function getMilestone(projectId: number, milestoneId: number) {
  return repo.getByIdForProject(projectId, milestoneId);
}

export async function createMilestone(
  projectId: number,
  sourceBibleId: number,
  input: CreateMilestoneInput
): Promise<Result<MilestoneRow>> {
  try {
    const validBookIds = await projectsRepo.getValidBookIdsForBible(sourceBibleId);
    const hasInvalidBooks = input.bookId.some((id) => !validBookIds.includes(id));
    if (hasInvalidBooks) {
      return err(ErrorCode.INVALID_BIBLE_BOOKS);
    }

    const created = await db.transaction(async (tx) => {
      const unit = await repo.insertMilestone(
        {
          projectId,
          name: input.name,
          status: input.status ?? 'not_started',
          type: input.type ?? 'text',
          connectivityProfile: input.connectivityProfile,
        },
        tx
      );

      await projectsRepo.insertBibleBookLinks(
        input.bookId.map((bookId) => ({
          projectUnitId: unit.id,
          bibleId: sourceBibleId,
          bookId,
        })),
        tx
      );

      const assignmentsResult =
        await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
          unit.id,
          sourceBibleId,
          input.bookId,
          tx
        );

      if (!assignmentsResult.ok) {
        throw new Error(assignmentsResult.error.message || 'Failed to create chapter assignments');
      }

      return unit;
    });

    await enqueueIngest(projectId, created.id, sourceBibleId, input.bookId);

    const loaded = await repo.getByIdForProject(projectId, created.id);
    if (!loaded.ok) return loaded;
    return ok(loaded.data);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create milestone',
      context: { projectId, sourceBibleId, bookId: input.bookId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function updateMilestone(
  projectId: number,
  milestoneId: number,
  input: UpdateMilestoneInput
): Promise<Result<MilestoneRow>> {
  if (Object.keys(input).length === 0) {
    return repo.getByIdForProject(projectId, milestoneId);
  }

  const updated = await repo.updateMilestone(projectId, milestoneId, input);
  if (!updated.ok) return updated;
  return repo.getByIdForProject(projectId, milestoneId);
}

export function deleteMilestone(projectId: number, milestoneId: number) {
  return repo.deleteMilestone(projectId, milestoneId);
}

async function enqueueIngest(
  projectId: number,
  projectUnitId: number,
  bibleId: number,
  bookIds: number[]
) {
  try {
    const queue = await getQueue();
    const ingestedBooks = await db
      .selectDistinct({ bookId: bible_texts.bookId })
      .from(bible_texts)
      .where(eq(bible_texts.bibleId, bibleId));
    const ingestedBookIds = ingestedBooks.map((r) => r.bookId);

    const validBookIds = await projectsRepo.getValidBookIdsForBible(bibleId);
    if (validBookIds.length === 0) {
      logger.warn('No valid books found for Bible, skipping text ingestion', { bibleId });
      return;
    }

    const dbBooks = await db.query.books.findMany({
      where: (books, { inArray }) => inArray(books.id, validBookIds),
    });

    const priorityBookCodes = dbBooks
      .filter((b) => bookIds.includes(b.id) && !ingestedBookIds.includes(b.id))
      .map((b) => b.code);

    if (priorityBookCodes.length === 0) return;

    await queue.send(
      QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
      {
        projectId,
        projectUnitId,
        bibleId,
        bookCodes: priorityBookCodes,
      },
      { priority: 10 }
    );
    logger.info('Enqueued text ingestion job for milestone books', {
      projectId,
      projectUnitId,
      bookCodes: priorityBookCodes,
    });
  } catch (error) {
    logger.error('Failed to enqueue text ingestion job for milestone', { error });
  }
}
