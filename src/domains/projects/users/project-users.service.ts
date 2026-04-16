import * as usersService from '@/domains/users/users.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './project-users.repository';

export function getProjectUsers(projectId: number) {
  return repo.getProjectUsers(projectId);
}

export async function addProjectUsers(projectId: number, userIds: number[]) {
  const usersResult = await usersService.getUsersByIds(userIds);
  if (!usersResult.ok) return err(ErrorCode.INTERNAL_ERROR);

  const foundIds = new Set(usersResult.data.map((u) => u.id));
  const missingId = userIds.find((id) => !foundIds.has(id));
  if (missingId) return err(ErrorCode.USER_NOT_FOUND);

  const insertResult = await repo.addProjectUsers(projectId, userIds);
  if (!insertResult.ok) return insertResult;

  const userMap = new Map(usersResult.data.map((u) => [u.id, u]));

  return ok(
    insertResult.data.map((row) => ({
      ...row,
      displayName: userMap.get(row.userId)!.username,
      roleID: userMap.get(row.userId)!.role,
    }))
  );
}

export function removeProjectUser(projectId: number, userId: number) {
  return repo.removeProjectUser(projectId, userId);
}

export function resolveIsProjectMember(projectId: number, userId: number, roleName: string) {
  return repo.resolveIsProjectMember(projectId, userId, roleName);
}
