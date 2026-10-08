import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { WorkflowStepResponse } from './workflow-stages.types';

import { db } from '../../../db';
import { project_workflow_stages } from '../../../db/schema';
import * as repo from './workflow-stages.repository';

export const DEFAULT_WORKFLOW = [
  { defaultName: 'not_started', displayName: 'Not Started', position: 0, isFixed: true },
  { defaultName: 'draft', displayName: 'Drafting', position: 1, isFixed: true },
  { defaultName: 'peer_check', displayName: 'Peer Check', position: 2, isFixed: true },
  { defaultName: 'community_review', displayName: 'Community Review', position: 3, isFixed: false },
  { defaultName: 'linguist_check', displayName: 'Linguist Check', position: 4, isFixed: false },
  {
    defaultName: 'theological_check',
    displayName: 'Theological Check',
    position: 5,
    isFixed: false,
  },
  { defaultName: 'consultant_check', displayName: 'Consultant Check', position: 6, isFixed: false },
  { defaultName: 'complete', displayName: 'Complete', position: 7, isFixed: true },
];

export async function seedDefaultStages(projectId: number, tx: any = db) {
  const stagesToInsert = DEFAULT_WORKFLOW.map((s) => ({
    projectId,
    ...s,
  }));
  await tx.insert(project_workflow_stages).values(stagesToInsert).onConflictDoNothing();
}

export async function getWorkflowStages(projectId: number): Promise<WorkflowStepResponse[]> {
  let stages = await repo.getWorkflowStagesByProjectId(projectId);

  if (stages.length === 0) {
    await seedDefaultStages(projectId);
    stages = await repo.getWorkflowStagesByProjectId(projectId);
  }

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);

  return stages.map((stage) => ({
    id: stage.defaultName,
    label: stage.displayName,
    stageId: stage.id,
    position: stage.position,
    isFixed: stage.isFixed,
    isLocked: lockedDefaultNames.includes(stage.defaultName),
  }));
}

export async function addStage(
  projectId: number,
  displayName: string
): Promise<WorkflowStepResponse> {
  const stages = await repo.getWorkflowStagesByProjectId(projectId);
  const configurableCount = stages.filter(
    (s) => s.defaultName !== 'not_started' && s.defaultName !== 'complete'
  ).length;

  if (configurableCount >= 10) {
    throw new Error('Maximum of 10 configurable stages reached.');
  }

  const existingName = stages.find(
    (s) => s.displayName.toLowerCase() === displayName.toLowerCase()
  );
  if (existingName) {
    throw new Error('A stage with this name already exists.');
  }

  // Complete is always last. Bump Complete's position, insert new stage at previous Complete position.
  const completeStage = stages.find((s) => s.defaultName === 'complete');
  if (!completeStage) throw new Error('Complete stage not found');

  let newStageResult;
  await db.transaction(async (tx) => {
    // shift complete down
    await tx
      .update(project_workflow_stages)
      .set({ position: completeStage.position + 1 })
      .where(eq(project_workflow_stages.id, completeStage.id));

    newStageResult = await repo.addWorkflowStage(tx, {
      projectId,
      defaultName: `custom_${nanoid(10)}`,
      displayName,
      position: completeStage.position,
      isFixed: false,
    });
  });

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
  return {
    id: newStageResult!.defaultName,
    label: newStageResult!.displayName,
    stageId: newStageResult!.id,
    position: newStageResult!.position,
    isFixed: newStageResult!.isFixed,
    isLocked: lockedDefaultNames.includes(newStageResult!.defaultName),
  };
}

export async function renameStage(
  projectId: number,
  stageId: number,
  displayName: string
): Promise<WorkflowStepResponse> {
  const stages = await repo.getWorkflowStagesByProjectId(projectId);
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) throw new Error('Stage not found');

  if (stage.defaultName === 'not_started' || stage.defaultName === 'complete') {
    throw new Error('Cannot rename this stage.');
  }

  const existingName = stages.find(
    (s) => s.displayName.toLowerCase() === displayName.toLowerCase() && s.id !== stageId
  );
  if (existingName) {
    throw new Error('A stage with this name already exists.');
  }

  const updated = await repo.renameWorkflowStage(stageId, displayName);
  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);

  return {
    id: updated.defaultName,
    label: updated.displayName,
    stageId: updated.id,
    position: updated.position,
    isFixed: updated.isFixed,
    isLocked: lockedDefaultNames.includes(updated.defaultName),
  };
}

export async function deleteStage(
  projectId: number,
  stageId: number
): Promise<WorkflowStepResponse[]> {
  const stages = await repo.getWorkflowStagesByProjectId(projectId);
  const stage = stages.find((s) => s.id === stageId);
  if (!stage) throw new Error('Stage not found');

  if (stage.isFixed) {
    throw new Error(`Cannot delete fixed stage "${stage.displayName}".`);
  }

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
  if (lockedDefaultNames.includes(stage.defaultName)) {
    throw new Error(`Cannot delete locked stage "${stage.displayName}".`);
  }

  await db.transaction(async (tx) => {
    await tx.delete(project_workflow_stages).where(eq(project_workflow_stages.id, stageId));
    // Shift following stages up
    const subsequentStages = stages.filter((s) => s.position > stage.position);
    for (const s of subsequentStages) {
      await tx
        .update(project_workflow_stages)
        .set({ position: s.position - 1 })
        .where(eq(project_workflow_stages.id, s.id));
    }
  });

  return getWorkflowStages(projectId);
}

export async function reorderStages(
  projectId: number,
  stageIds: number[]
): Promise<WorkflowStepResponse[]> {
  const stages = await repo.getWorkflowStagesByProjectId(projectId);
  if (stages.length !== stageIds.length) {
    throw new Error('Invalid stage list. All stages must be included.');
  }

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);

  // Validate fixed and locked stages haven't moved
  for (let i = 0; i < stages.length; i++) {
    const originalStage = stages[i];
    const newIndex = stageIds.indexOf(originalStage.id);

    if (newIndex === -1) {
      throw new Error('Missing stage in reorder.');
    }

    if (originalStage.isFixed && newIndex !== originalStage.position) {
      throw new Error(`Cannot move fixed stage "${originalStage.displayName}".`);
    }

    if (
      lockedDefaultNames.includes(originalStage.defaultName) &&
      newIndex !== originalStage.position
    ) {
      throw new Error(`Cannot move locked stage "${originalStage.displayName}".`);
    }
  }

  await db.transaction(async (tx) => {
    // Pass 1: Set positions to negative to avoid unique constraint violations
    for (let i = 0; i < stageIds.length; i++) {
      await tx
        .update(project_workflow_stages)
        .set({ position: -(i + 1) })
        .where(eq(project_workflow_stages.id, stageIds[i]));
    }
    // Pass 2: Set final positive positions
    for (let i = 0; i < stageIds.length; i++) {
      await tx
        .update(project_workflow_stages)
        .set({ position: i })
        .where(eq(project_workflow_stages.id, stageIds[i]));
    }
  });

  return getWorkflowStages(projectId);
}
