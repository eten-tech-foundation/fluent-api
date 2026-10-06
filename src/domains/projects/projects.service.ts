import { and, eq, isNotNull } from 'drizzle-orm';

import type { AppPolicyUser, DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { bible_books, bible_texts, pericope_sets } from '@/db/schema';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  CreateProjectServiceInput,
  ParsedUsfmFile,
  Project,
  UpdateProjectInput,
} from './projects.types';

import * as projectChapterAssignmentsRepo from './chapter-assignments/project-chapter-assignments.repository';
import * as repo from './projects.repository';
import * as usfmImportService from './usfm-import.service';

export function getProjectsByOrganization(organizationId: number) {
  return repo.getByOrganization(organizationId);
}

export function getProjectsForUser(user: AppPolicyUser) {
  // Global view grant (SuperAdmin) fetches all projects
  const hasGlobalView = user.grants.some(
    (g) => g.orgId === null && g.projectId === null && g.permissions.has(PERMISSIONS.PROJECT_VIEW)
  );
  if (hasGlobalView) {
    return repo.getAllProjects();
  }

  const orgIds = new Set<number>();
  const projectIds = new Set<number>();
  for (const g of user.grants) {
    if (!g.permissions.has(PERMISSIONS.PROJECT_VIEW)) continue;
    if (g.projectId !== null) projectIds.add(g.projectId);
    else if (g.orgId !== null) orgIds.add(g.orgId);
  }
  return repo.findByOrgIdsOrProjectIds([...orgIds], [...projectIds]);
}

export async function getProjectsByUserId(
  userId: number,
  orgId?: number,
  updatedAfter?: Date,
  roleName?: string
) {
  return repo.getByUserId(userId, orgId, updatedAfter, roleName);
}

export function getProjectById(id: number) {
  return repo.getById(id);
}

export function lockProjectById(id: number, tx: DbTransaction) {
  return repo.lockProjectById(id, tx);
}

export async function deleteProject(
  id: number,
  options?: { cascadeUnits?: boolean }
): Promise<Result<void>> {
  if (options?.cascadeUnits) return repo.remove(id);

  return db.transaction(async (tx) => {
    const exists = await repo.lockProjectById(id, tx);
    if (!exists) return err(ErrorCode.PROJECT_NOT_FOUND);

    const count = await repo.countUnitsByProjectId(id, tx);
    if (count > 0) return err(ErrorCode.PROJECT_HAS_MILESTONES);

    return repo.remove(id, tx);
  });
}

export function getProjectIdByUnitId(projectUnitId: number) {
  return repo.getProjectIdByUnitId(projectUnitId);
}

// Update project activity timestamp on chapter assignment changes.
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

/** Activate a not_assigned project and bump lastActivityAt when a chapter is first assigned. */
export async function recordProjectAssignmentActivity(
  projectUnitId: number,
  tx: DbTransaction
): Promise<void> {
  const projectIds = await projectChapterAssignmentsRepo.findNotAssignedProjectIds(
    [projectUnitId],
    tx
  );
  await projectChapterAssignmentsRepo.activateProjects(projectIds, tx);
  await touchProjectActivity(projectUnitId, tx);
}

export async function createProject(
  requested: CreateProjectServiceInput
): Promise<Result<Project>> {
  // Create-from-existing-data (#419): every file is parsed before anything is written, and the
  // books the files carry replace whatever the client listed, since the files are the authority.
  let importedFiles: ParsedUsfmFile[] | null = null;
  const bibleId = requested.sourceBibleId ?? requested.bibleId;
  if (
    bibleId === undefined ||
    (requested.bibleId != null &&
      requested.sourceBibleId != null &&
      requested.bibleId !== requested.sourceBibleId)
  ) {
    return err(ErrorCode.VALIDATION_ERROR);
  }
  let input = { ...requested, bibleId, sourceBibleId: bibleId, bookId: requested.bookId ?? [] };
  // Current clients create milestones separately. Only imports and explicit legacy book
  // requests keep the initial-unit creation used before milestones were introduced.
  const createInitialUnit = requested.usfmFiles?.length || requested.bookId?.length;
  try {
    if (requested.usfmFiles?.length) {
      const parsed = await usfmImportService.parseUsfmFiles(requested.usfmFiles);
      if (!parsed.ok) return parsed;
      importedFiles = parsed.data;
      input = { ...input, bookId: importedFiles.map((file) => file.bookId) };
    }

    const validBookIds = createInitialUnit ? await repo.getValidBookIdsForBible(input.bibleId) : [];
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

    let createdProjectUnitId: number | null = null;
    const result = await db.transaction(async (tx) => {
      const {
        bibleId,
        bookId,
        projectUnitStatus = 'not_started',
        usfmFiles: _usfmFiles,
        ...projectData
      } = input;

      const project = await repo.insertProjectRecord(
        { ...projectData, status: 'not_assigned' },
        tx
      );

      if (!createInitialUnit) return ok(project);

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

      if (importedFiles) {
        await repo.insertUsfmImports(
          importedFiles.map((file) => ({
            projectUnitId: projectUnit.id,
            bookId: file.bookId,
            fileName: file.fileName,
            usfm: file.usfm,
          })),
          tx
        );
        createdProjectUnitId = projectUnit.id;
      }

      // Enqueue the on-demand text ingestion job. Inside the transaction because an import
      // whose job was never queued would sit pending forever with only a log line as evidence:
      // rolling the creation back lets the caller retry instead of owning a project whose
      // verses can never arrive.
      try {
        // Imported verses need a complete source book, including when another project is
        // still ingesting it. Preserve the existing queue policy for blank projects.
        const ingestedBooks = importedFiles
          ? await db
              .select({ bookId: bible_books.bookId })
              .from(bible_books)
              .where(
                and(eq(bible_books.bibleId, input.bibleId), isNotNull(bible_books.textIngestedAt))
              )
          : await db
              .selectDistinct({ bookId: bible_texts.bookId })
              .from(bible_texts)
              .where(eq(bible_texts.bibleId, input.bibleId));
        const ingestedBookIds = ingestedBooks.map((r) => r.bookId);

        // Get all available books for this Bible
        const validBookIds = await repo.getValidBookIdsForBible(input.bibleId);
        if (validBookIds.length === 0) {
          logger.warn('No valid books found for Bible, skipping text ingestion', {
            bibleId: input.bibleId,
          });
          return ok(project);
        }
        const dbBooks = await db.query.books.findMany({
          where: (books, { inArray }) => inArray(books.id, validBookIds),
        });

        const priorityBookCodes = dbBooks
          .filter((b) => input.bookId.includes(b.id) && !ingestedBookIds.includes(b.id))
          .map((b) => b.code);

        // As per discussion: only pulling up selected books for now.
        // Background ingestion of remaining Bible books is disabled until
        // we have proper rate-limit budgeting and a clear product need.
        // const backgroundBookCodes = dbBooks
        //   .filter((b) => !input.bookId.includes(b.id) && !ingestedBookIds.includes(b.id))
        //   .map((b) => b.code);

        // Enqueue priority ingestion for the exact requested books
        if (priorityBookCodes.length > 0) {
          const queue = await getQueue();
          await queue.send(
            QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
            {
              projectId: project.id,
              bibleId: input.bibleId,
              bookCodes: priorityBookCodes,
            },
            { priority: 10 }
          );
          logger.info('Enqueued text ingestion job for requested books', {
            projectId: project.id,
            bookCodes: priorityBookCodes,
          });
        }

        // As per discussion: only pulling up selected books for now.
        // Uncomment the block below to enable background ingestion of
        // remaining books in the Bible for future projects.
        // if (backgroundBookCodes.length > 0) {
        //   await queue.send(QUEUE_NAMES.DBL_INGEST_TEXT, {
        //     projectId: result.data.id,
        //     bibleId: input.bibleId,
        //     bookCodes: backgroundBookCodes,
        //   });
        //   logger.info('Enqueued text ingestion job for remaining books', {
        //     projectId: result.data.id,
        //     bookCodes: backgroundBookCodes,
        //   });
        // }
      } catch (error) {
        logger.error('Failed to enqueue text ingestion job', { error });
        // #419: only an import depends on the job to ever produce its verses. A blank project
        // keeps the pre-existing behaviour of being created anyway.
        if (importedFiles) throw error;
      }

      return ok(project);
    });

    // Decide ingestion first so completion racing with this request cannot leave an import
    // pending without its own job. Completed books are materialized here; the worker handles
    // the rest. Never fail a committed project creation because materialization failed.
    if (result.ok && importedFiles && createdProjectUnitId !== null) {
      const materialized = await usfmImportService.materializePendingUsfmImports(
        createdProjectUnitId,
        input.bibleId,
        importedFiles.map((file) => file.bookId),
        importedFiles
      );
      if (materialized.ok) {
        logger.info('Imported USFM materialised at project creation', {
          projectId: result.data.id,
          ...materialized.data,
        });
      } else {
        logger.error({
          message: 'Failed to materialise imported USFM at project creation',
          context: {
            projectId: result.data.id,
            projectUnitId: createdProjectUnitId,
            error: materialized.error,
          },
        });
        // Completed source books have no ingestion job to revisit this import.
        // Retry each book independently; successful inserts are idempotent.
        for (const file of importedFiles) {
          try {
            const queue = await getQueue();
            await queue.send(
              QUEUE_NAMES.USFM_IMPORT_MATERIALIZE,
              { bibleId: input.bibleId, bookId: file.bookId },
              { singletonKey: `${input.bibleId}:${file.bookId}` }
            );
          } catch (error) {
            // The pending import is also a durable intent: the worker's recurring
            // recovery sweep rediscovers it once the queue becomes available.
            logger.error('Failed to queue USFM materialisation retry', {
              projectId: result.data.id,
              bibleId: input.bibleId,
              bookId: file.bookId,
              error,
            });
          }
        }
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
      const updatedProject = await repo.updateProjectRecord(id, input, tx);

      if (!updatedProject) {
        return err(ErrorCode.PROJECT_NOT_FOUND);
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
