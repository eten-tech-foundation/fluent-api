import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { Executor, Tx } from './workflow-stages.repository';
import type { WorkflowStepResponse } from './workflow-stages.types';

import { db } from '../../../db';
import { project_workflow_stages, projects } from '../../../db/schema';
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

const MAX_WORKFLOW_STAGES = 10;
const START_STAGE = 'not_started';
const END_STAGE = 'complete';

type StageRow = typeof project_workflow_stages.$inferSelect;

export class WorkflowStageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowStageValidationError';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function seedDefaultStages(projectId: number, executor: Executor = db) {
  const stagesToInsert = DEFAULT_WORKFLOW.map((s) => ({ projectId, ...s }));
  await executor.insert(project_workflow_stages).values(stagesToInsert).onConflictDoNothing();
}

/**
 * Locks the project row until the surrounding transaction ends, so only one
 * stage change per project runs at a time. Exported so other code (e.g. chapter
 * submission) can take the same lock.
 */
export async function lockProject(tx: Tx, projectId: number) {
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update');
  if (!row) throw new Error('Project not found');
}

/** Reads stages inside the transaction, seeding the defaults if there are none. */
export async function readStagesSeeded(tx: Tx, projectId: number): Promise<StageRow[]> {
  let stages = await repo.getWorkflowStagesByProjectId(projectId, tx);
  if (stages.length === 0) {
    await seedDefaultStages(projectId, tx);
    stages = await repo.getWorkflowStagesByProjectId(projectId, tx);
  }
  return stages;
}

function toResponse(stage: StageRow, lockedDefaultNames: string[]): WorkflowStepResponse {
  return {
    id: stage.defaultName,
    label: stage.displayName,
    stageId: stage.id,
    position: stage.position,
    isFixed: stage.isFixed,
    isLocked: lockedDefaultNames.includes(stage.defaultName),
  };
}

function hasDuplicateName(stages: StageRow[], displayName: string, ignoreStageId?: number) {
  const wanted = displayName.toLowerCase();
  return stages.some((s) => s.id !== ignoreStageId && s.displayName.toLowerCase() === wanted);
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function getWorkflowStages(projectId: number): Promise<WorkflowStepResponse[]> {
  let stages = await repo.getWorkflowStagesByProjectId(projectId);

  if (stages.length === 0) {
    // Safe if two requests seed at once: onConflictDoNothing + unique indexes.
    await seedDefaultStages(projectId);
    stages = await repo.getWorkflowStagesByProjectId(projectId);
  }

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
  return stages.map((stage) => toResponse(stage, lockedDefaultNames));
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export async function addStage(
  projectId: number,
  displayName: string
): Promise<WorkflowStepResponse> {
  const created = await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const stages = await readStagesSeeded(tx, projectId);

    if (stages.length >= MAX_WORKFLOW_STAGES) {
      throw new WorkflowStageValidationError(
        `Maximum of ${MAX_WORKFLOW_STAGES} workflow stages reached.`
      );
    }

    if (hasDuplicateName(stages, displayName)) {
      throw new WorkflowStageValidationError('A stage with this name already exists.');
    }

    // "Complete" must stay last: move it down one, then put the new stage in its old slot.
    // The move has to come first, otherwise two rows would share a position.
    const completeStage = stages.find((s) => s.defaultName === END_STAGE);
    if (!completeStage) throw new Error('Complete stage not found');

    await tx
      .update(project_workflow_stages)
      .set({ position: completeStage.position + 1 })
      .where(eq(project_workflow_stages.id, completeStage.id));

    return repo.addWorkflowStage(tx, {
      projectId,
      defaultName: `custom_${nanoid(10)}`,
      displayName,
      position: completeStage.position,
      isFixed: false,
    });
  });

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
  return toResponse(created, lockedDefaultNames);
}

export async function renameStage(
  projectId: number,
  stageId: number,
  displayName: string
): Promise<WorkflowStepResponse> {
  const updated = await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const stages = await readStagesSeeded(tx, projectId);

    const stage = stages.find((s) => s.id === stageId);
    if (!stage) throw new WorkflowStageValidationError('Stage not found');

    if (stage.defaultName === START_STAGE || stage.defaultName === END_STAGE) {
      throw new WorkflowStageValidationError('Cannot rename this stage.');
    }
    if (hasDuplicateName(stages, displayName, stageId)) {
      throw new WorkflowStageValidationError('A stage with this name already exists.');
    }

    return repo.renameWorkflowStage(stageId, displayName, tx);
  });

  const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
  return toResponse(updated, lockedDefaultNames);
}

export async function deleteStage(
  projectId: number,
  stageId: number
): Promise<WorkflowStepResponse[]> {
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const stages = await readStagesSeeded(tx, projectId);

    const stage = stages.find((s) => s.id === stageId);
    if (!stage) throw new WorkflowStageValidationError('Stage not found');

    if (stage.isFixed) {
      throw new WorkflowStageValidationError(`Cannot delete fixed stage "${stage.displayName}".`);
    }

    const lockedDefaultNames = await repo.getLockedDefaultNames(projectId, tx);
    if (lockedDefaultNames.includes(stage.defaultName)) {
      throw new WorkflowStageValidationError(`Cannot delete locked stage "${stage.displayName}".`);
    }

    await tx.delete(project_workflow_stages).where(eq(project_workflow_stages.id, stageId));

    // Close the gap. `stages` is sorted ascending, so each stage moves into a slot
    // that was just freed and never collides with another row.
    const following = stages.filter((s) => s.position > stage.position);
    for (const s of following) {
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
  await db.transaction(async (tx) => {
    await lockProject(tx, projectId);
    const stages = await readStagesSeeded(tx, projectId);

    // The request must contain every current stage exactly once.
    const currentIds = new Set(stages.map((s) => s.id));
    const requestedIds = new Set(stageIds);
    if (
      stageIds.length !== stages.length ||
      requestedIds.size !== stageIds.length ||
      stageIds.some((id) => !currentIds.has(id))
    ) {
      throw new WorkflowStageValidationError(
        'Invalid stage list. All stages must be included exactly once.'
      );
    }

    const lockedDefaultNames = await repo.getLockedDefaultNames(projectId, tx);

    // Fixed and locked stages must stay where they are.
    for (const original of stages) {
      const newIndex = stageIds.indexOf(original.id);

      if (original.isFixed && newIndex !== original.position) {
        throw new WorkflowStageValidationError(
          `Cannot move fixed stage "${original.displayName}".`
        );
      }
      if (lockedDefaultNames.includes(original.defaultName) && newIndex !== original.position) {
        throw new WorkflowStageValidationError(
          `Cannot move locked stage "${original.displayName}".`
        );
      }
    }

    // Pass 1: park every stage on a negative position so the unique index never trips.
    for (let i = 0; i < stageIds.length; i++) {
      await tx
        .update(project_workflow_stages)
        .set({ position: -(i + 1) })
        .where(eq(project_workflow_stages.id, stageIds[i]));
    }
    // Pass 2: write the final positions.
    for (let i = 0; i < stageIds.length; i++) {
      await tx
        .update(project_workflow_stages)
        .set({ position: i })
        .where(eq(project_workflow_stages.id, stageIds[i]));
    }
  });

  return getWorkflowStages(projectId);
}
