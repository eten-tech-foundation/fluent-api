import { asc, eq, inArray } from 'drizzle-orm';

import type { InsertProjectWorkflowStage, ProjectWorkflowStage } from '@/db/schema';
import type { DbTransaction } from '@/lib/types';

import { db } from '@/db';
import {
  chapter_assignment_status_history,
  chapter_assignments,
  project_units,
  project_workflow_stages,
} from '@/db/schema';

// Either the global db or a transaction handle; both expose select/insert/update/delete.
export type Executor = typeof db | DbTransaction;

export async function getWorkflowStagesByProjectId(
  projectId: number,
  executor: Executor = db
): Promise<ProjectWorkflowStage[]> {
  return executor
    .select()
    .from(project_workflow_stages)
    .where(eq(project_workflow_stages.projectId, projectId))
    .orderBy(asc(project_workflow_stages.position));
}

export async function addWorkflowStage(
  executor: Executor,
  data: InsertProjectWorkflowStage
): Promise<ProjectWorkflowStage> {
  const [newStage] = await executor.insert(project_workflow_stages).values(data).returning();
  return newStage;
}

/**
 * A stage is "locked" once any chapter in the project has ever reached it.
 * Uses `chapter_assignment_status_history` (the ever-written audit log) rather
 * than `chapter_assignments.status` (current state) so that chapters which are
 * reset backward still lock the stages they previously passed.
 *
 * Lock cascades to every earlier stage (by position).
 */
export async function getLockedDefaultNames(
  projectId: number,
  executor: Executor = db
): Promise<string[]> {
  // Join history → assignments → project_units to filter by project.
  const rows = await executor
    .selectDistinct({ status: chapter_assignment_status_history.status })
    .from(chapter_assignment_status_history)
    .innerJoin(
      chapter_assignments,
      eq(chapter_assignments.id, chapter_assignment_status_history.chapterAssignmentId)
    )
    .innerJoin(project_units, eq(project_units.id, chapter_assignments.projectUnitId))
    .where(eq(project_units.projectId, projectId));

  if (rows.length === 0) return [];

  const usedStatuses = new Set(rows.map((r) => r.status));
  const stages = await getWorkflowStagesByProjectId(projectId, executor);

  // Highest position among stages that any chapter has ever reached.
  let maxPosition = -1;
  for (const stage of stages) {
    if (usedStatuses.has(stage.defaultName) && stage.position > maxPosition) {
      maxPosition = stage.position;
    }
  }
  if (maxPosition === -1) return [];

  return stages.filter((s) => s.position <= maxPosition).map((s) => s.defaultName);
}

/**
 * Batch version of `getLockedDefaultNames` for a set of projects.
 * Returns a Map keyed by projectId.
 */
export async function getLockedDefaultNamesByProjectIds(
  projectIds: number[]
): Promise<Map<number, string[]>> {
  if (projectIds.length === 0) return new Map();

  const rows = await db
    .selectDistinct({
      projectId: project_units.projectId,
      status: chapter_assignment_status_history.status,
    })
    .from(chapter_assignment_status_history)
    .innerJoin(
      chapter_assignments,
      eq(chapter_assignments.id, chapter_assignment_status_history.chapterAssignmentId)
    )
    .innerJoin(project_units, eq(project_units.id, chapter_assignments.projectUnitId))
    .where(inArray(project_units.projectId, projectIds));

  const stages = await db
    .select()
    .from(project_workflow_stages)
    .where(inArray(project_workflow_stages.projectId, projectIds))
    .orderBy(asc(project_workflow_stages.position));

  // Group: projectId → stages (sorted by position, already from DB)
  const stagesByProject = new Map<number, ProjectWorkflowStage[]>();
  for (const stage of stages) {
    if (!stagesByProject.has(stage.projectId)) stagesByProject.set(stage.projectId, []);
    stagesByProject.get(stage.projectId)!.push(stage);
  }

  // Group: projectId → set of ever-reached statuses
  const usedByProject = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!usedByProject.has(row.projectId)) usedByProject.set(row.projectId, new Set());
    usedByProject.get(row.projectId)!.add(row.status);
  }

  const result = new Map<number, string[]>();
  for (const projectId of projectIds) {
    const projectStages = stagesByProject.get(projectId) ?? [];
    const usedStatuses = usedByProject.get(projectId) ?? new Set<string>();

    let maxPosition = -1;
    for (const s of projectStages) {
      if (usedStatuses.has(s.defaultName) && s.position > maxPosition) {
        maxPosition = s.position;
      }
    }
    result.set(
      projectId,
      maxPosition === -1
        ? []
        : projectStages.filter((s) => s.position <= maxPosition).map((s) => s.defaultName)
    );
  }
  return result;
}

export async function renameWorkflowStage(
  stageId: number,
  displayName: string,
  executor: Executor = db
): Promise<ProjectWorkflowStage> {
  const [updated] = await executor
    .update(project_workflow_stages)
    .set({ displayName })
    .where(eq(project_workflow_stages.id, stageId))
    .returning();
  return updated;
}
