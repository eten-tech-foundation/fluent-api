import { and, eq, isNull, or } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, projects, user_roles, users } from '@/db/schema';
import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import { getRoleId } from '@/domains/user-roles/user-roles.service';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUserRecord } from './project-users.types';

// Repository functions

export async function getProjectUsers(projectId: number): Promise<Result<ProjectUserRecord[]>> {
  try {
    const [project] = await db
      .select({ organization: projects.organization })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

    const rows = await db
      .select({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        displayName: users.username,
        roleID: user_roles.roleId,
        createdAt: user_roles.createdAt,
      })
      .from(user_roles)
      .innerJoin(users, eq(user_roles.userId, users.id))
      .where(eq(user_roles.projectId, projectId))
      .orderBy(users.username);

    // Deduplicate by userId, keeping the grant with the highest privilege (lowest roleID)
    const uniqueUsers = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      const existing = uniqueUsers.get(r.userId);
      if (!existing || r.roleID < existing.roleID) {
        uniqueUsers.set(r.userId, r);
      }
    }

    // Map `projectId: null` to `projectId` for the UI.
    const projectUsers = Array.from(uniqueUsers.values()).map((r) => ({
      ...r,
      projectId: r.projectId ?? projectId,
    }));
    return ok(projectUsers as any);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project users',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function addProjectUsers(
  projectId: number,
  userIds: number[],
  roleId: number
): Promise<
  Result<{ projectId: number; userId: number; roleId: number; createdAt: Date | null }[]>
> {
  if (userIds.length === 0) return ok([]);
  try {
    const [project] = await db
      .select({ organization: projects.organization })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

    // Verify all userIds belong to the project's organization to prevent cross-tenant membership leaks
    const memberIds = await findUserIdsInOrg(project.organization, userIds);
    const nonMember = userIds.find((id) => !memberIds.has(id));
    if (nonMember) {
      return err(ErrorCode.USER_NOT_FOUND);
    }

    // Validate that the provided roleId is one of the three project-level roles
    const [pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const validProjectRoleIds = new Set([pmId, ptId, poId]);
    if (!validProjectRoleIds.has(roleId)) {
      return err(ErrorCode.NOT_FOUND);
    }

    const inserted = await db
      .insert(user_roles)
      .values(
        userIds.map((userId) => ({
          projectId,
          userId,
          orgId: project.organization,
          roleId,
        }))
      )
      .onConflictDoNothing()
      .returning({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        roleId: user_roles.roleId,
        createdAt: user_roles.createdAt,
      });

    return ok(inserted as any);
  } catch (error) {
    const constraintResult = handleConstraintError(error);
    if (!constraintResult.ok && constraintResult.error.code === ErrorCode.DUPLICATE) {
      return err(ErrorCode.USER_ALREADY_IN_PROJECT);
    }
    logger.error({
      cause: error,
      message: 'Failed to bulk add users to project',
      context: { projectId, userIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function removeProjectUser(projectId: number, userId: number): Promise<Result<void>> {
  try {
    const [assignedContent] = await db
      .select({ userId: chapter_assignments.assignedUserId })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .where(
        and(
          eq(project_units.projectId, projectId),
          or(
            eq(chapter_assignments.assignedUserId, userId),
            eq(chapter_assignments.peerCheckerId, userId)
          )
        )
      )
      .limit(1);

    if (assignedContent) return err(ErrorCode.USER_HAS_ASSIGNED_CONTENT);

    const deleted = await db
      .delete(user_roles)
      .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
      .returning({ userId: user_roles.userId });

    if (deleted.length === 0) return err(ErrorCode.USER_NOT_IN_PROJECT);

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to remove user from project',
      context: { projectId, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function resolveIsProjectMember(projectId: number, userId: number): Promise<boolean> {
  const [pinned] = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .where(and(eq(user_roles.userId, userId), eq(user_roles.projectId, projectId)))
    .limit(1);
  if (pinned) return true;

  const rows = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .innerJoin(projects, eq(projects.id, projectId))
    .where(
      and(
        eq(user_roles.userId, userId),
        eq(user_roles.orgId, projects.organization),
        isNull(user_roles.projectId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function getProjectUserRole(
  projectId: number,
  userId: number
): Promise<number | null> {
  const [row] = await db
    .select({ roleId: user_roles.roleId })
    .from(user_roles)
    .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
    .limit(1);
  return row ? row.roleId : null;
}

export async function updateProjectUserRole(
  projectId: number,
  userId: number,
  roleId: number
): Promise<Result<{ projectId: number; userId: number; roleId: number; createdAt: Date | null }>> {
  try {
    // Validate that the provided roleId is one of the three project-level roles
    const [pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const validProjectRoleIds = new Set([pmId, ptId, poId]);
    if (!validProjectRoleIds.has(roleId)) {
      return err(ErrorCode.NOT_FOUND);
    }

    const [updated] = await db
      .update(user_roles)
      .set({ roleId })
      .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
      .returning({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        roleId: user_roles.roleId,
        createdAt: user_roles.createdAt,
      });

    if (!updated) {
      return err(ErrorCode.USER_NOT_IN_PROJECT);
    }

    return ok(updated as any);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update project user role',
      context: { projectId, userId, roleId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
