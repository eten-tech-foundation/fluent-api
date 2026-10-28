import type { ProjectRole } from '@/lib/roles';
import type { Result } from '@/lib/types';

import * as usersService from '@/domains/users/users.service';
import { isProjectRole, ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUserRecord } from './project-users.types';

import * as repo from './project-users.repository';

const PROJECT_ROLE_PRIORITY: Record<ProjectRole, number> = {
  [ROLES.PROJECT_MANAGER]: 3,
  [ROLES.PROJECT_TRANSLATOR]: 2,
  [ROLES.PROJECT_OBSERVER]: 1,
};

const priority = (roleName: string) =>
  isProjectRole(roleName) ? PROJECT_ROLE_PRIORITY[roleName] : 0;

// A user may hold several project-level grants in one project (the unique index
// allows one row per role); the effective grant is the one with the
// highest-priority project role.
function resolveEffectiveProjectGrant(
  rows: repo.ProjectUserGrantRow[]
): repo.ProjectUserGrantRow[] {
  const byUser = new Map<number, repo.ProjectUserGrantRow>();
  for (const row of rows) {
    const existing = byUser.get(row.userId);
    if (!existing || priority(row.roleName) > priority(existing.roleName)) {
      byUser.set(row.userId, row);
    }
  }
  return [...byUser.values()];
}

export async function getProjectUsers(projectId: number): Promise<Result<ProjectUserRecord[]>> {
  const result = await repo.getProjectUsers(projectId);
  if (!result.ok) return result;

  return ok(
    resolveEffectiveProjectGrant(result.data).map((r) => ({
      projectId,
      userId: r.userId,
      displayName: r.username,
      roleID: r.roleId,
      roleName: r.roleName,
      createdAt: r.createdAt,
    }))
  );
}

export async function addProjectUsers(
  createdBy: number,
  projectId: number,
  userIds: number[],
  roleId: number,
  roleName: string
) {
  const usersResult = await usersService.getUsersByIds(userIds);
  if (!usersResult.ok) return err(ErrorCode.INTERNAL_ERROR);

  const foundIds = new Set(usersResult.data.map((u) => u.id));
  const missingId = userIds.find((id) => !foundIds.has(id));
  if (missingId) return err(ErrorCode.USER_NOT_FOUND);

  const insertResult = await repo.addProjectUsers(createdBy, projectId, userIds, roleId, roleName);
  if (!insertResult.ok) return insertResult;

  const userMap = new Map(usersResult.data.map((u) => [u.id, u]));

  return ok(
    insertResult.data.map((row) => ({
      ...row,
      displayName: userMap.get(row.userId)!.username,
      roleID: row.roleId,
      roleName: row.roleName,
    }))
  );
}

export function removeProjectUser(projectId: number, userId: number) {
  return repo.removeProjectUser(projectId, userId);
}

export function resolveIsProjectMember(projectId: number, userId: number) {
  return repo.resolveIsProjectMember(projectId, userId);
}

export async function updateProjectUserRole(
  createdBy: number,
  projectId: number,
  userId: number,
  roleId: number,
  roleName: string
) {
  if (createdBy === userId) {
    return err(ErrorCode.FORBIDDEN);
  }

  const userResult = await usersService.getUsersByIds([userId]);
  if (!userResult.ok) return err(ErrorCode.INTERNAL_ERROR);
  if (userResult.data.length === 0) return err(ErrorCode.USER_NOT_FOUND);

  const result = await repo.updateProjectUserRole(projectId, userId, roleId, roleName);
  if (!result.ok) return result;

  const targetUser = userResult.data[0];

  return ok({
    ...result.data,
    displayName: targetUser.username,
    roleID: result.data.roleId,
    roleName: result.data.roleName,
  });
}
