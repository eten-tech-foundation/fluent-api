import * as repo from './project-users.repository';

export function getProjectUsers(projectId: number) {
  return repo.getProjectUsers(projectId);
}

export function addProjectUsers(projectId: number, userIds: number[]) {
  return repo.addProjectUsers(projectId, userIds);
}

export function removeProjectUser(projectId: number, userId: number) {
  return repo.removeProjectUser(projectId, userId);
}

export function resolveIsProjectMember(projectId: number, userId: number, roleName: string) {
  return repo.resolveIsProjectMember(projectId, userId, roleName);
}
