import type {
  ParsedUsfmFile,
  UsfmFileCheck,
  UsfmFileToCheck,
} from '@/domains/projects/projects.types';
import type { DbTransaction, Result } from '@/lib/types';

import { runInTransaction } from '@/db/transaction';
import * as bibleBooksService from '@/domains/bible-books/bible-books.service';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectsService from '@/domains/projects/projects.service';
import * as usfmImportService from '@/domains/projects/usfm-import.service';
import { logger } from '@/lib/logger';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type { MilestoneRow } from './milestones.types';

import * as repo from './milestones.repository';

/**
 * The Add Milestone Import tab's per-file check (#418): nothing is written. `listedBookCodes`
 * are the books the dialog has already accepted, so a second file for one of them is refused.
 */
export async function checkUsfmFilesForMilestone(
  projectId: number,
  sourceBibleId: number,
  files: UsfmFileToCheck[],
  listedBookCodes: string[] = []
): Promise<Result<UsfmFileCheck[]>> {
  const prepared = await usfmImportService.prepareUsfmImport(
    { projectId, sourceBibleId },
    files,
    listedBookCodes
  );
  if (!prepared.ok) return prepared;
  return ok(prepared.data.verdicts);
}

type UsfmMilestoneImportOutcome =
  { kind: 'created'; milestone: MilestoneRow } | { kind: 'rejected'; files: UsfmFileCheck[] };

/**
 * Queues source-text ingestion for every imported book whose source text is not complete yet.
 * Its verses can only be attached once the book is complete, so an import whose job was never
 * queued would stay pending forever: a queue failure rolls the whole import back.
 */
async function queueIncompleteSourceBooks(
  sourceBibleId: number,
  projectUnitId: number,
  files: ParsedUsfmFile[],
  tx: DbTransaction
): Promise<Result<void>> {
  const completion = await Promise.all(
    files.map((file) => bibleBooksService.isBibleBookTextIngested(sourceBibleId, file.bookId, tx))
  );
  const incomplete: string[] = [];
  for (const [index, result] of completion.entries()) {
    if (!result.ok) return result;
    if (!result.data) incomplete.push(files[index].bookCode);
  }
  if (incomplete.length === 0) return ok(undefined);

  try {
    const queue = await getQueue();
    // One job per book, the way Add Milestone queues them, so one slow book doesn't hold the rest.
    await Promise.all(
      incomplete.map((bookCode) =>
        queue.send(
          QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
          { bibleId: sourceBibleId, bookCodes: [bookCode], projectUnitId },
          { priority: 10 }
        )
      )
    );
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to enqueue text ingestion for a USFM milestone import',
      context: { sourceBibleId, projectUnitId, bookCodes: incomplete },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Attaches the imported verses of books whose source text is already complete. The milestone is
 * committed by now, so a failure here never undoes it: each book gets a retry job instead, and
 * the worker's recovery sweep picks up any book that job misses.
 */
async function materializeImport(
  sourceBibleId: number,
  projectUnitId: number,
  files: ParsedUsfmFile[]
) {
  const bookIds = files.map((file) => file.bookId);
  const materialized = await usfmImportService.materializePendingUsfmImports(
    projectUnitId,
    sourceBibleId,
    bookIds,
    files
  );
  if (materialized.ok) {
    logger.info('Imported USFM materialised for a new milestone', {
      projectUnitId,
      ...materialized.data,
    });
    return;
  }

  logger.error({
    message: 'Failed to materialise imported USFM for a new milestone',
    context: { projectUnitId, sourceBibleId, error: materialized.error },
  });
  try {
    const queue = await getQueue();
    await Promise.all(
      bookIds.map((bookId) =>
        queue.send(
          QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
          { bibleId: sourceBibleId, bookId },
          { singletonKey: `${sourceBibleId}:${bookId}` }
        )
      )
    );
  } catch (error) {
    logger.warn('Could not queue USFM materialisation retries; the recovery sweep will', {
      projectUnitId,
      error,
    });
  }
}

/**
 * Creates one milestone from validated USFM files (#419). The books come from the files, and the
 * languages, Source Bible, connectivity and pericope set from the project. Every file is checked
 * again first, and the books are checked once more inside the project lock, so a book added to
 * the project after the dialog checked it still blocks the import instead of being merged.
 */
export async function importUsfmMilestone(
  projectId: number,
  sourceBibleId: number,
  name: string,
  files: UsfmFileToCheck[]
): Promise<Result<UsfmMilestoneImportOutcome>> {
  const prepared = await usfmImportService.prepareUsfmImport({ projectId, sourceBibleId }, files);
  if (!prepared.ok) return prepared;
  const { verdicts, accepted } = prepared.data;
  if (verdicts.some((verdict) => !verdict.ok)) return ok({ kind: 'rejected', files: verdicts });

  const created = await runInTransaction(async (tx) => {
    await projectsService.lockProjectById(projectId, tx);

    const inProject = await usfmImportService.getBooksInProject(projectId, tx);
    if (accepted.some((file) => inProject.has(file.bookId))) {
      return err(ErrorCode.USFM_BOOK_EXISTS);
    }

    const milestone = await repo.insertMilestoneRecord(
      projectId,
      { name, type: 'text', status: 'not_started' },
      tx
    );
    const bookIds = accepted.map((file) => file.bookId);
    await repo.insertBibleBookLinks(
      bookIds.map((bookId) => ({ projectUnitId: milestone.id, bibleId: sourceBibleId, bookId })),
      tx
    );

    const assignments = await chapterAssignmentsService.createChapterAssignmentForProjectUnit(
      milestone.id,
      sourceBibleId,
      bookIds,
      tx
    );
    if (!assignments.ok) return assignments;

    await usfmImportService.recordUsfmImports(milestone.id, accepted, tx);

    const queued = await queueIncompleteSourceBooks(sourceBibleId, milestone.id, accepted, tx);
    if (!queued.ok) return queued;

    return ok(milestone.id);
  });
  if (!created.ok) return created;

  await materializeImport(sourceBibleId, created.data, accepted);

  const milestone = await repo.getByIdForProject(projectId, created.data);
  if (!milestone) return err(ErrorCode.NOT_FOUND);
  return ok({ kind: 'created', milestone });
}
