import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_books,
  books,
  chapter_assignments,
  project_unit_bible_books,
  project_unit_usfm_imports,
  project_units,
  project_workflow_stages,
  projects,
  roles,
  user_roles,
} from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { RawProjectRow } from './projects.query-builder';
import type {
  ChapterStatusCounts,
  CreateProjectData,
  Project,
  ProjectUnitRef,
  ProjectWithLanguageNames,
  UpdateProjectData,
  WorkflowStep,
} from './projects.types';

import { baseJoinQuery } from './projects.query-builder';
import { DEFAULT_WORKFLOW } from './workflow-stages/workflow-stages.constants';
import { getLockedDefaultNamesByProjectIds } from './workflow-stages/workflow-stages.repository';

const WORKFLOW_DEFINITION: WorkflowStep[] = DEFAULT_WORKFLOW.map((stage) => ({
  id: stage.defaultName,
  label: stage.displayName,
  isLocked: false,
}));

// NOTE: mapper lives here because it is tightly coupled to the raw join shape from baseJoinQuery.
export function mapToProjectWithLanguages(
  rawProject: RawProjectRow,
  stages: WorkflowStep[] = WORKFLOW_DEFINITION,
  defaultCounts: ChapterStatusCounts = Object.fromEntries(
    DEFAULT_WORKFLOW.map((s) => [s.defaultName, 0])
  )
): ProjectWithLanguageNames {
  const { counts, milestoneCount, ...rest } = rawProject;
  return {
    ...rest,
    chapterStatusCounts: { ...defaultCounts, ...(counts || {}) },
    milestoneCount: milestoneCount ?? 0,
    workflowConfig: stages,
  };
}

export async function populateWorkflowStages(
  projects: ProjectWithLanguageNames[]
): Promise<ProjectWithLanguageNames[]> {
  if (projects.length === 0) return projects;
  const projectIds = projects.map((p) => p.id);
  const stages = await db
    .select()
    .from(project_workflow_stages)
    .where(inArray(project_workflow_stages.projectId, projectIds))
    .orderBy(project_workflow_stages.position);

  // Load lock state in one batch query.
  const lockedByProject = await getLockedDefaultNamesByProjectIds(projectIds);

  const stagesByProject = new Map<number, WorkflowStep[]>();
  // Also track the default status-count map per project from its own stages.
  const defaultCountsByProject = new Map<number, ChapterStatusCounts>();

  for (const stage of stages) {
    if (!stagesByProject.has(stage.projectId)) {
      stagesByProject.set(stage.projectId, []);
      defaultCountsByProject.set(stage.projectId, {});
    }
    const lockedNames = lockedByProject.get(stage.projectId) ?? [];
    stagesByProject.get(stage.projectId)!.push({
      id: stage.defaultName,
      label: stage.displayName,
      stageId: stage.id,
      position: stage.position,
      isFixed: stage.isFixed,
      isLocked: lockedNames.includes(stage.defaultName),
    });
    // Zero-fill from the project's own stage list.
    defaultCountsByProject.get(stage.projectId)![stage.defaultName] = 0;
  }

  return projects.map((p) => {
    const workflowConfig = stagesByProject.get(p.id) ?? WORKFLOW_DEFINITION;
    const defaultCounts =
      defaultCountsByProject.get(p.id) ??
      Object.fromEntries(DEFAULT_WORKFLOW.map((s) => [s.defaultName, 0]));

    const allowedStageIds = new Set(workflowConfig.map((s) => s.id));
    const mergedCounts: ChapterStatusCounts = { ...defaultCounts };
    if (p.chapterStatusCounts) {
      for (const [k, v] of Object.entries(p.chapterStatusCounts)) {
        if (allowedStageIds.has(k)) {
          mergedCounts[k] = v;
        } else if (v > 0) {
          logger.warn(
            { projectId: p.id, status: k, count: v },
            'Project chapterStatusCounts contains non-zero count for status not in workflow stages; dropping from response'
          );
        }
      }
    }

    return {
      ...p,
      workflowConfig,
      chapterStatusCounts: mergedCounts,
    };
  });
}

// Repository functions

export async function getByOrganization(
  organizationId: number
): Promise<Result<ProjectWithLanguageNames[]>> {
  try {
    const rawProjects = await baseJoinQuery().where(eq(projects.organization, organizationId));
    return ok(await populateWorkflowStages(rawProjects.map((p) => mapToProjectWithLanguages(p))));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get projects by organization',
      context: { organizationId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getAllProjects(): Promise<Result<ProjectWithLanguageNames[]>> {
  try {
    const rawProjects = await baseJoinQuery();
    return ok(await populateWorkflowStages(rawProjects.map((p) => mapToProjectWithLanguages(p))));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get all projects' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByOrgIdsOrProjectIds(
  orgIds: number[],
  projectIds: number[]
): Promise<Result<ProjectWithLanguageNames[]>> {
  if (orgIds.length === 0 && projectIds.length === 0) return ok([]);
  try {
    const conditions = [];
    if (orgIds.length) conditions.push(inArray(projects.organization, orgIds));
    if (projectIds.length) conditions.push(inArray(projects.id, projectIds));
    const rows = await baseJoinQuery().where(or(...conditions));
    return ok(await populateWorkflowStages(rows.map((p) => mapToProjectWithLanguages(p))));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find projects for user' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getByUserId(
  userId: number,
  orgId?: number,
  updatedAfter?: Date,
  roleName?: string
): Promise<Result<ProjectWithLanguageNames[]>> {
  try {
    let query = baseJoinQuery()
      .innerJoin(
        user_roles,
        and(
          eq(user_roles.userId, userId),
          or(
            // Explicit project-level grant — always counts.
            eq(user_roles.projectId, projects.id),
            // Org-level grant — only counts for roles other than 'Org Member'.
            and(eq(user_roles.orgId, projects.organization), isNull(user_roles.projectId))
          )
        )
      )
      .innerJoin(roles, eq(roles.id, user_roles.roleId))
      .$dynamic();

    const conditions = [];
    if (orgId !== undefined) conditions.push(eq(projects.organization, orgId));
    if (updatedAfter) conditions.push(gt(projects.updatedAt, updatedAfter));

    // When a specific role is requested, only return projects where
    // the user holds that exact role.
    if (roleName) {
      conditions.push(eq(roles.name, roleName));
    }

    conditions.push(
      or(
        // Project-scoped grant — role name doesn't matter.
        eq(user_roles.projectId, projects.id),
        // Org-scoped grant — must NOT be the plain 'Org Member' anchor role.
        and(isNull(user_roles.projectId), ne(roles.name, 'Org Member'))
      )
    );

    query = query.where(and(...conditions));

    const rawProjects = await query;

    // Deduplicate: a user with both org-wide + project-pinned grants gets the same project twice
    const seen = new Map<number, (typeof rawProjects)[number]>();
    for (const row of rawProjects) {
      if (!seen.has(row.id)) seen.set(row.id, row);
    }
    return ok(
      await populateWorkflowStages([...seen.values()].map((p) => mapToProjectWithLanguages(p)))
    );
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get projects by user ID',
      context: { userId, updatedAfter },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<ProjectWithLanguageNames>> {
  try {
    const rawProjects = await baseJoinQuery().where(eq(projects.id, id)).limit(1);
    if (rawProjects.length === 0) return err(ErrorCode.PROJECT_NOT_FOUND);
    const populated = await populateWorkflowStages([mapToProjectWithLanguages(rawProjects[0])]);
    return ok(populated[0]);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to get project by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insertProjectRecord(
  projectData: CreateProjectData,
  tx: DbTransaction
): Promise<Project> {
  const [project] = await tx.insert(projects).values(projectData).returning();
  return project;
}

export async function updateProjectRecord(
  id: number,
  projectData: UpdateProjectData,
  tx: DbTransaction
): Promise<Project | undefined> {
  const [updated] = await tx
    .update(projects)
    .set(projectData)
    .where(eq(projects.id, id))
    .returning();
  return updated;
}

export async function remove(id: number, tx?: DbTransaction): Promise<Result<void>> {
  try {
    const conn = tx ?? db;
    const [deleted] = await conn
      .delete(projects)
      .where(eq(projects.id, id))
      .returning({ id: projects.id });
    if (!deleted) return err(ErrorCode.PROJECT_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to delete project', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function touchLastActivity(projectId: number, tx: DbTransaction): Promise<void> {
  await tx.update(projects).set({ lastActivityAt: new Date() }).where(eq(projects.id, projectId));
}

export async function getProjectIdByUnitId(
  projectUnitId: number,
  tx?: DbTransaction
): Promise<Result<ProjectUnitRef>> {
  try {
    const conn = tx ?? db;
    const [unit] = await conn
      .select({ projectId: project_units.projectId })
      .from(project_units)
      .where(eq(project_units.id, projectUnitId))
      .limit(1);

    if (!unit) return err(ErrorCode.PROJECT_UNIT_NOT_FOUND);
    return ok({ projectId: unit.projectId });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project unit ID by project ID',
      context: { projectUnitId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findAssignmentIdsNotInProject(
  projectId: number,
  chapterAssignmentIds: number[],
  tx: DbTransaction
): Promise<number[]> {
  const rows = await tx
    .select({ id: chapter_assignments.id })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
    .where(
      and(
        inArray(chapter_assignments.id, chapterAssignmentIds),
        eq(project_units.projectId, projectId)
      )
    );

  const validIds = new Set(rows.map((r) => r.id));
  return chapterAssignmentIds.filter((id) => !validIds.has(id));
}

export async function countUnitsByProjectId(
  projectId: number,
  tx?: DbTransaction
): Promise<number> {
  const conn = tx ?? db;
  const rows = await conn
    .select({ count: sql<number>`count(*)::int` })
    .from(project_units)
    .where(eq(project_units.projectId, projectId));
  return rows[0].count;
}

export async function lockProjectById(id: number, tx: DbTransaction): Promise<boolean> {
  // Use a raw SQL query since Drizzle doesn't have a first-class FOR UPDATE yet without trickery
  const res = await tx.execute(sql`SELECT id FROM ${projects} WHERE id = ${id} FOR UPDATE`);
  if (Array.isArray(res)) return res.length > 0;
  return ((res as any).rows?.length ?? 0) > 0;
}

export async function getValidBookIdsForBible(bibleId: number): Promise<number[]> {
  const rows = await db
    .select({ bookId: bible_books.bookId })
    .from(bible_books)
    .where(eq(bible_books.bibleId, bibleId));
  return rows.map((r) => r.bookId);
}

export async function insertProjectUnitRecord(
  unitData: {
    projectId: number;
    status: 'not_started' | 'in_progress' | 'completed';
    name?: string;
  },
  tx: DbTransaction
) {
  const [projectUnit] = await tx.insert(project_units).values(unitData).returning();
  return projectUnit;
}

/** English display names of the given books, ordered by book ID like the project book list. */
export async function getBookDisplayNames(bookIds: number[], tx: DbTransaction): Promise<string[]> {
  if (bookIds.length === 0) return [];
  const rows = await tx
    .select({ name: books.eng_display_name })
    .from(books)
    .where(inArray(books.id, bookIds))
    .orderBy(asc(books.id));
  return rows.map((row) => row.name);
}

export async function insertBibleBookLinks(
  bibleBookEntries: { projectUnitId: number; bibleId: number; bookId: number }[],
  tx: DbTransaction
) {
  if (bibleBookEntries.length > 0) {
    await tx.insert(project_unit_bible_books).values(bibleBookEntries);
  }
}

// ─── Imported USFM (#419) ─────────────────────────────────────────────────────

export async function insertUsfmImports(
  rows: { projectUnitId: number; bookId: number; fileName: string; usfm: string }[],
  tx: DbTransaction
) {
  if (rows.length > 0) {
    await tx.insert(project_unit_usfm_imports).values(rows);
  }
}

/** Imports whose verses have not been attached to source text yet, for the given books. */
export async function getPendingUsfmImports(projectUnitId: number, bookIds: number[]) {
  if (bookIds.length === 0) return [];
  return db
    .select({
      id: project_unit_usfm_imports.id,
      projectUnitId: project_unit_usfm_imports.projectUnitId,
      bookId: project_unit_usfm_imports.bookId,
      usfm: project_unit_usfm_imports.usfm,
    })
    .from(project_unit_usfm_imports)
    .where(
      and(
        eq(project_unit_usfm_imports.projectUnitId, projectUnitId),
        inArray(project_unit_usfm_imports.bookId, bookIds),
        isNull(project_unit_usfm_imports.materializedAt)
      )
    );
}

/**
 * The same pending imports, for every project unit waiting on these books of this Bible rather
 * than for one project. A completed book finishes all of them at once, so a project whose own
 * ingestion job never ran is not left waiting on it forever. The join keeps a project unit that
 * imported the same book against a different Bible out: its verses belong to that Bible's text.
 */
export async function getPendingUsfmImportsForBible(bibleId: number, bookIds: number[]) {
  if (bookIds.length === 0) return [];
  return db
    .select({
      id: project_unit_usfm_imports.id,
      projectUnitId: project_unit_usfm_imports.projectUnitId,
      bookId: project_unit_usfm_imports.bookId,
      usfm: project_unit_usfm_imports.usfm,
    })
    .from(project_unit_usfm_imports)
    .innerJoin(
      project_unit_bible_books,
      and(
        eq(project_unit_bible_books.projectUnitId, project_unit_usfm_imports.projectUnitId),
        eq(project_unit_bible_books.bookId, project_unit_usfm_imports.bookId),
        eq(project_unit_bible_books.bibleId, bibleId)
      )
    )
    .where(
      and(
        inArray(project_unit_usfm_imports.bookId, bookIds),
        isNull(project_unit_usfm_imports.materializedAt)
      )
    );
}

export async function markUsfmImportMaterialized(
  id: number,
  executor: DbTransaction | typeof db = db
) {
  await executor
    .update(project_unit_usfm_imports)
    .set({ materializedAt: new Date() })
    .where(eq(project_unit_usfm_imports.id, id));
}

/** Pending rows are durable retry intents, even when their original queue send failed. */
export async function getUsfmImportsReadyForMaterialization() {
  return db
    .selectDistinct({
      bibleId: project_unit_bible_books.bibleId,
      bookId: project_unit_usfm_imports.bookId,
    })
    .from(project_unit_usfm_imports)
    .innerJoin(
      project_unit_bible_books,
      and(
        eq(project_unit_bible_books.projectUnitId, project_unit_usfm_imports.projectUnitId),
        eq(project_unit_bible_books.bookId, project_unit_usfm_imports.bookId)
      )
    )
    .innerJoin(
      bible_books,
      and(
        eq(bible_books.bibleId, project_unit_bible_books.bibleId),
        eq(bible_books.bookId, project_unit_usfm_imports.bookId)
      )
    )
    .where(
      and(
        isNull(project_unit_usfm_imports.materializedAt),
        isNull(project_unit_bible_books.deletedAt),
        isNotNull(bible_books.textIngestedAt)
      )
    );
}
