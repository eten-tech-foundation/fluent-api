import { eq } from 'drizzle-orm';

import type { AppPolicyUser, DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import { pericope_sets, project_units } from '@/db/schema';
import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateProjectServiceInput, Project, UpdateProjectInput } from './projects.types';

import * as projectChapterAssignmentsRepo from './chapter-assignments/project-chapter-assignments.repository';
import * as repo from './projects.repository';

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

export async function deleteProject(id: number): Promise<Result<void>> {
  const units = await db
    .select({ id: project_units.id })
    .from(project_units)
    .where(eq(project_units.projectId, id))
    .limit(1);

  if (units.length > 0) {
    return err(ErrorCode.PROJECT_HAS_MILESTONES);
  }

  return repo.remove(id);
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

export async function createProject(input: CreateProjectServiceInput): Promise<Result<Project>> {
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

    const result = await db.transaction(async (tx) => {
      const project = await repo.insertProjectRecord({ ...input, status: 'not_assigned' }, tx);
      return ok(project);
    });

    return result;
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create project',
      context: {
        organization: input.organization,
        sourceBibleId: input.sourceBibleId,
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
