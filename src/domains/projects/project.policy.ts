/**
 * src/domains/projects/project.policy.ts
 *
 * Record-level access rules for projects.
 *
 * Called AFTER requirePermission() has confirmed the role has the permission.
 * These functions answer: can THIS user act on THIS specific project?
 */

import type { AppPolicyUser } from '@/lib/types';

import { ROLES } from '@/lib/roles';

import type { ProjectWithLanguageNames } from './projects.types';

/**
 * Internal helper to check if a user has modification rights over a project.
 */
const _canModifyProject = (user: AppPolicyUser, project: ProjectWithLanguageNames): boolean => {
  return user.roleName === ROLES.PROJECT_MANAGER && project.organization === user.organization;
};

export const ProjectPolicy = {
  /**
   * Can this user list all projects in the standard org route?
   *
   * Project Manager : yes.
   * Translator      : no (they will use a separate /users/me/projects endpoint).
   */
  list(user: AppPolicyUser): boolean {
    return user.roleName === ROLES.PROJECT_MANAGER;
  },

  /**
   * Can this user view this specific project?
   *
   * Project Manager : yes, if the project belongs to their organisation.
   * Translator      : yes, if they are assigned to at least one chapter in it.
   *
   * `isAssignedToProject` is resolved inline in the route handler by checking
   * the project_users table. Defaults to false.
   */
  read(
    user: AppPolicyUser,
    project: ProjectWithLanguageNames,
    isAssignedToProject = false
  ): boolean {
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return project.organization === user.organization;
    }

    if (user.roleName === ROLES.TRANSLATOR) {
      return isAssignedToProject;
    }

    return false;
  },

  /**
   * Can this user update this project?
   *
   * Project Manager : yes, if the project belongs to their organisation.
   * Translator      : never.
   */
  update(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return _canModifyProject(user, project);
  },

  /**
   * Can this user delete this project?
   *
   * Project Manager : yes, if the project belongs to their organisation.
   * Translator      : never.
   */
  delete(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return _canModifyProject(user, project);
  },
};
