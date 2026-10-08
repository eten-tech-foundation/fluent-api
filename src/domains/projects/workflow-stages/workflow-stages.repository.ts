import { eq, sql } from 'drizzle-orm';

import type { InsertProjectWorkflowStage, ProjectWorkflowStage } from '../../../db/schema';

import { db } from '../../../db';
import { chapter_assignments, project_workflow_stages } from '../../../db/schema';

export async function getWorkflowStagesByProjectId(
  projectId: number
): Promise<ProjectWorkflowStage[]> {
  return await db
    .select()
    .from(project_workflow_stages)
    .where(eq(project_workflow_stages.projectId, projectId))
    .orderBy(project_workflow_stages.position);
}

export async function addWorkflowStage(
  tx: any,
  data: InsertProjectWorkflowStage
): Promise<ProjectWorkflowStage> {
  const [newStage] = await tx.insert(project_workflow_stages).values(data).returning();
  return newStage;
}

export async function getLockedDefaultNames(projectId: number): Promise<string[]> {
  // Find highest position of any reached stage
  // chapter_assignments -> project_units -> projects is implied since chapter_assignments is isolated by projectUnitId,
  // but chapter_assignments has no projectId. However, projectUnit has projectId.
  const activeStatusesQuery = db
    .select({ status: chapter_assignments.status })
    .from(chapter_assignments)
    .innerJoin(
      sql`project_units`,
      sql`project_units.id = chapter_assignments.project_unit_id AND project_units.project_id = ${projectId}`
    )
    .groupBy(chapter_assignments.status);

  const statuses = await activeStatusesQuery;
  const statusStrings = statuses.map((s) => s.status);

  if (statusStrings.length === 0) {
    return [];
  }

  // Find max position
  const stages = await getWorkflowStagesByProjectId(projectId);
  let maxPosition = -1;
  for (const stage of stages) {
    if (statusStrings.includes(stage.defaultName as any)) {
      if (stage.position > maxPosition) {
        maxPosition = stage.position;
      }
    }
  }

  if (maxPosition === -1) {
    return [];
  }

  // Cascade lock
  return stages.filter((s) => s.position <= maxPosition).map((s) => s.defaultName);
}

export async function renameWorkflowStage(
  stageId: number,
  displayName: string
): Promise<ProjectWorkflowStage> {
  const [updated] = await db
    .update(project_workflow_stages)
    .set({ displayName })
    .where(eq(project_workflow_stages.id, stageId))
    .returning();
  return updated;
}
