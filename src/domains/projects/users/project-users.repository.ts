import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import {
  chapter_assignments,
  project_units,
  projects,
  roles,
  user_roles,
  users,
} from '@/db/schema';
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

    // Exclude the Org Member anchor role (zero permissions, backend-only, never shown in UI).
    const orgMemberRoleId = await getRoleId(ROLES.ORG_MEMBER);

    const rows = await db
      .select({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        displayName: users.username,
        roleID: user_roles.roleId,
        roleName: roles.name,
        createdAt: user_roles.createdAt,
      })
      .from(user_roles)
      .innerJoin(users, eq(user_roles.userId, users.id))
      .innerJoin(roles, eq(roles.id, user_roles.roleId))
      .where(
        and(
          // Include project-pinned grants for this project OR org-wide grants for the project's org.
          or(
            eq(user_roles.projectId, projectId),
            and(isNull(user_roles.projectId), eq(user_roles.orgId, project.organization))
          ),
          // Exclude Org Member anchor rows — they carry zero permissions and are not displayed.
          sql`${user_roles.roleId} != ${orgMemberRoleId}`
        )
      )
      .orderBy(users.username);

    const [orgMgrId, pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.ORG_MANAGER),
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const rolePriorityMap = new Map<number, number>([
      [orgMgrId, 4],
      [pmId, 3],
      [ptId, 2],
      [poId, 1],
    ]);
    const getRolePriority = (roleId: number) => rolePriorityMap.get(roleId) ?? 0;

    const uniqueUsers = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      const existing = uniqueUsers.get(r.userId);
      if (
        !existing ||
        (r.projectId !== null && existing.projectId === null) ||
        (Boolean(r.projectId) === Boolean(existing.projectId) &&
          getRolePriority(r.roleID) > getRolePriority(existing.roleID))
      ) {
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
  roleId: number,
  roleName: string
): Promise<
  Result<
    {
      projectId: number;
      userId: number;
      roleId: number;
      roleName: string;
      createdAt: Date | null;
    }[]
  >
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

    return ok(inserted.map((r) => ({ ...r, roleName })) as any);
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
    return await db.transaction(async (tx) => {
      // 1. Delete the project-scoped grant first.
      const deleted = await tx
        .delete(user_roles)
        .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
        .returning({ userId: user_roles.userId });

      if (deleted.length === 0) return err(ErrorCode.USER_NOT_IN_PROJECT);

      // 2. Find all chapter_assignment IDs in this project where the user is assigned.
      const affectedIds = await tx
        .select({ id: chapter_assignments.id })
        .from(chapter_assignments)
        .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
        .where(
          and(
            eq(project_units.projectId, projectId),
            sql`(${chapter_assignments.assignedUserId} = ${userId} OR ${chapter_assignments.peerCheckerId} = ${userId})`
          )
        );

      // 3. Null out the user's drafter / peer-checker columns on those assignments.
      if (affectedIds.length > 0) {
        const ids = affectedIds.map((r) => r.id);
        await tx
          .update(chapter_assignments)
          .set({
            assignedUserId: sql`CASE WHEN ${chapter_assignments.assignedUserId} = ${userId} THEN NULL ELSE ${chapter_assignments.assignedUserId} END`,
            peerCheckerId: sql`CASE WHEN ${chapter_assignments.peerCheckerId} = ${userId} THEN NULL ELSE ${chapter_assignments.peerCheckerId} END`,
          })
          .where(inArray(chapter_assignments.id, ids));
      }

      return ok(undefined);
    });
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
  roleId: number,
  roleName: string
): Promise<
  Result<{
    projectId: number;
    userId: number;
    roleId: number;
    roleName: string;
    createdAt: Date | null;
  }>
> {
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

    if (updated) {
      return ok({ ...updated, roleName } as any);
    }

    // If no project-pinned row exists, check if the user is a member of the project
    const [project] = await db
      .select({ organization: projects.organization })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

    const isMember = await resolveIsProjectMember(projectId, userId);
    if (!isMember) {
      return err(ErrorCode.USER_NOT_IN_PROJECT);
    }

    // Insert project-pinned grant row for this user
    const [inserted] = await db
      .insert(user_roles)
      .values({
        userId,
        orgId: project.organization,
        projectId,
        roleId,
      })
      .onConflictDoNothing()
      .returning({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        roleId: user_roles.roleId,
        createdAt: user_roles.createdAt,
      });

    if (!inserted) {
      const [existingRow] = await db
        .select({
          projectId: user_roles.projectId,
          userId: user_roles.userId,
          roleId: user_roles.roleId,
          createdAt: user_roles.createdAt,
        })
        .from(user_roles)
        .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
        .limit(1);

      if (!existingRow) return err(ErrorCode.USER_NOT_IN_PROJECT);
      return ok({ ...existingRow, roleName } as any);
    }

    return ok({ ...inserted, roleName } as any);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update project user role',
      context: { projectId, userId, roleId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
