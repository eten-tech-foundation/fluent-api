import { asc, eq } from 'drizzle-orm';

import type { InsertProjectWorkflowStage, ProjectWorkflowStage } from '../../../db/schema';

import { db } from '../../../db';
import { chapter_assignments, project_units, project_workflow_stages } from '../../../db/schema';

// Either the global db or a transaction handle; both expose select/insert/update/delete.
export type Tx = any;
export type Executor = any;

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
 * A stage is "locked" once any chapter in the project has reached it.
 * The lock cascades to every earlier stage.
 */
export async function getLockedDefaultNames(
  projectId: number,
  executor: Executor = db
): Promise<string[]> {
  // chapter_assignments has no projectId, so join through project_units.
  const rows = await executor
    .select({ status: chapter_assignments.status })
    .from(chapter_assignments)
    .innerJoin(project_units, eq(project_units.id, chapter_assignments.projectUnitId))
    .where(eq(project_units.projectId, projectId))
    .groupBy(chapter_assignments.status);

  if (rows.length === 0) return [];

  const usedStatuses = new Set(rows.map((r: any) => r.status));
  const stages = await getWorkflowStagesByProjectId(projectId, executor);

  // Highest position among stages that at least one chapter currently sits in.
  let maxPosition = -1;
  for (const stage of stages) {
    if (usedStatuses.has(stage.defaultName) && stage.position > maxPosition) {
      maxPosition = stage.position;
    }
  }
  if (maxPosition === -1) return [];

  return stages.filter((s) => s.position <= maxPosition).map((s) => s.defaultName);
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
