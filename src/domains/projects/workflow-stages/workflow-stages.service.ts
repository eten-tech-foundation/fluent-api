import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { project_workflow_stages, projects } from '@/db/schema';
import { err, ErrorCode, ok } from '@/lib/types';

import type { WorkflowStepResponse } from './workflow-stages.types';

import {
  DEFAULT_WORKFLOW,
  END_STAGE,
  MAX_WORKFLOW_STAGES,
  START_STAGE,
} from './workflow-stages.constants';
import * as repo from './workflow-stages.repository';

type StageRow = typeof project_workflow_stages.$inferSelect;

export type { Executor } from './workflow-stages.repository';

// ─── Helpers ─────────────────────────────────────────────────────────────────

export async function seedDefaultStages(
  projectId: number,
  executor: typeof db | DbTransaction = db
) {
  const stagesToInsert = DEFAULT_WORKFLOW.map((s) => ({ projectId, ...s }));
  await executor.insert(project_workflow_stages).values(stagesToInsert).onConflictDoNothing();
}

/**
 * Locks the project row until the surrounding transaction ends, so only one
 * stage change per project runs at a time. Exported so other code (e.g. chapter
 * submission) can take the same lock.
 */
export async function lockProject(tx: DbTransaction, projectId: number): Promise<Result<void>> {
  const [row] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .for('update');
  if (!row) return err(ErrorCode.WORKFLOW_PROJECT_NOT_FOUND);
  return ok(undefined);
}

/** Reads stages inside the transaction, seeding the defaults if there are none. */
export async function readStagesSeeded(tx: DbTransaction, projectId: number): Promise<StageRow[]> {
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
  const wanted = displayName.trim().toLowerCase();
  return stages.some(
    (s) => s.id !== ignoreStageId && s.displayName.trim().toLowerCase() === wanted
  );
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Returns the workflow stages for a project.
 * Missing stages (no rows) are treated as a configuration error — the GET
 * endpoint no longer silently seeds the DB on read.
 */
export async function getWorkflowStages(
  projectId: number
): Promise<Result<WorkflowStepResponse[]>> {
  try {
    const stages = await repo.getWorkflowStagesByProjectId(projectId);
    if (stages.length === 0) return err(ErrorCode.WORKFLOW_NOT_CONFIGURED);

    const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
    return ok(stages.map((stage) => toResponse(stage, lockedDefaultNames)));
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

// ─── Mutations ───────────────────────────────────────────────────────────────

export async function addStage(
  projectId: number,
  displayName: string
): Promise<Result<WorkflowStepResponse>> {
  try {
    const created = await db.transaction(async (tx) => {
      const lockResult = await lockProject(tx, projectId);
      if (!lockResult.ok) return lockResult;

      const stages = await readStagesSeeded(tx, projectId);

      const lockedDefaultNames = await repo.getLockedDefaultNames(projectId, tx);
      if (lockedDefaultNames.includes(END_STAGE)) {
        return err(ErrorCode.WORKFLOW_STAGE_LOCKED);
      }

      // Count only configurable stages (exclude bookend not_started / complete).
      const configurableCount = stages.filter(
        (s) => s.defaultName !== START_STAGE && s.defaultName !== END_STAGE
      ).length;
      if (configurableCount >= MAX_WORKFLOW_STAGES) {
        return err(ErrorCode.WORKFLOW_STAGE_LIMIT_REACHED);
      }

      let finalDisplayName = displayName.trim();
      if (
        finalDisplayName.toLowerCase() === 'new stage' &&
        hasDuplicateName(stages, finalDisplayName)
      ) {
        let counter = 2;
        while (hasDuplicateName(stages, `New Stage ${counter}`)) {
          counter++;
        }
        finalDisplayName = `New Stage ${counter}`;
      } else if (hasDuplicateName(stages, finalDisplayName)) {
        return err(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }

      // "Complete" must stay last: move it down one, then put the new stage in its old slot.
      const completeStage = stages.find((s) => s.defaultName === END_STAGE);
      if (!completeStage) return err(ErrorCode.WORKFLOW_STAGE_COMPLETE_NOT_FOUND);

      await tx
        .update(project_workflow_stages)
        .set({ position: completeStage.position + 1 })
        .where(eq(project_workflow_stages.id, completeStage.id));

      const newStage = await repo.addWorkflowStage(tx, {
        projectId,
        defaultName: `custom_${nanoid(10)}`,
        displayName: finalDisplayName,
        position: completeStage.position,
        isFixed: false,
      });
      return ok(newStage);
    });

    if (!created.ok) return created;

    const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
    return ok(toResponse(created.data, lockedDefaultNames));
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function renameStage(
  projectId: number,
  stageId: number,
  displayName: string
): Promise<Result<WorkflowStepResponse>> {
  try {
    const updated = await db.transaction(async (tx) => {
      const lockResult = await lockProject(tx, projectId);
      if (!lockResult.ok) return lockResult;

      const stages = await readStagesSeeded(tx, projectId);
      const stage = stages.find((s) => s.id === stageId);

      if (!stage) return err(ErrorCode.WORKFLOW_STAGE_NOT_FOUND);
      if (stage.defaultName === START_STAGE || stage.defaultName === END_STAGE) {
        return err(ErrorCode.WORKFLOW_STAGE_FIXED);
      }
      const trimmedName = displayName.trim();
      if (hasDuplicateName(stages, trimmedName, stageId)) {
        return err(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
      }

      const renamedStage = await repo.renameWorkflowStage(stageId, trimmedName, tx);
      return ok(renamedStage);
    });

    if (!updated.ok) return updated;

    const lockedDefaultNames = await repo.getLockedDefaultNames(projectId);
    return ok(toResponse(updated.data, lockedDefaultNames));
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function deleteStage(
  projectId: number,
  stageId: number
): Promise<Result<WorkflowStepResponse[]>> {
  try {
    const deleted = await db.transaction(async (tx) => {
      const lockResult = await lockProject(tx, projectId);
      if (!lockResult.ok) return lockResult;

      const stages = await readStagesSeeded(tx, projectId);
      const stage = stages.find((s) => s.id === stageId);

      if (!stage) return err(ErrorCode.WORKFLOW_STAGE_NOT_FOUND);
      if (stage.isFixed) return err(ErrorCode.WORKFLOW_STAGE_FIXED);

      const lockedDefaultNames = await repo.getLockedDefaultNames(projectId, tx);
      if (lockedDefaultNames.includes(stage.defaultName)) {
        return err(ErrorCode.WORKFLOW_STAGE_LOCKED);
      }

      await tx.delete(project_workflow_stages).where(eq(project_workflow_stages.id, stageId));

      // Close the gap — sorted ascending, so each shift never collides.
      const following = stages.filter((s) => s.position > stage.position);
      for (const s of following) {
        await tx
          .update(project_workflow_stages)
          .set({ position: s.position - 1 })
          .where(eq(project_workflow_stages.id, s.id));
      }
      return ok(undefined);
    });

    if (!deleted.ok) return deleted;

    return getWorkflowStages(projectId);
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function reorderStages(
  projectId: number,
  stageIds: number[]
): Promise<Result<WorkflowStepResponse[]>> {
  try {
    const reordered = await db.transaction(async (tx) => {
      const lockResult = await lockProject(tx, projectId);
      if (!lockResult.ok) return lockResult;

      const stages = await readStagesSeeded(tx, projectId);

      // The request must contain every current stage exactly once.
      const currentIds = new Set(stages.map((s) => s.id));
      const requestedIds = new Set(stageIds);
      if (
        stageIds.length !== stages.length ||
        requestedIds.size !== stageIds.length ||
        stageIds.some((id) => !currentIds.has(id))
      ) {
        return err(ErrorCode.WORKFLOW_STAGE_INVALID_LIST);
      }

      const lockedDefaultNames = await repo.getLockedDefaultNames(projectId, tx);

      // Fixed and locked stages must stay where they are.
      for (const original of stages) {
        const newIndex = stageIds.indexOf(original.id);
        if (original.isFixed && newIndex !== original.position) {
          return err(ErrorCode.WORKFLOW_STAGE_FIXED);
        }
        if (lockedDefaultNames.includes(original.defaultName) && newIndex !== original.position) {
          return err(ErrorCode.WORKFLOW_STAGE_LOCKED);
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
      return ok(undefined);
    });

    if (!reordered.ok) return reordered;

    return getWorkflowStages(projectId);
  } catch {
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
