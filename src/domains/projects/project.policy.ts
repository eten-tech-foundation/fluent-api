/**
 * src/domains/projects/project.policy.ts
 *
 * Record-level access rules for projects.
 *
 * Called AFTER requirePermission() has confirmed the role has the permission.
 * These functions answer: can THIS user act on THIS specific project?
 */

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

import type { ProjectWithLanguageNames } from './projects.types';

export const ProjectPolicy = {
  /** Can list projects at all? Anyone with project:view in any scope. */
  list(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.PROJECT_VIEW));
  },

  read(
    user: AppPolicyUser,
    project: ProjectWithLanguageNames,
    isAssignedToProject = false
  ): boolean {
    const scope = { orgId: project.organization, projectId: project.id };
    if (authorize(user, PERMISSIONS.PROJECT_VIEW, scope)) return true;
    // Translators with no org/project-wide view still see projects they're assigned to.
    return isAssignedToProject;
  },

  update(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return authorize(user, PERMISSIONS.PROJECT_UPDATE, {
      orgId: project.organization,
      projectId: project.id,
    });
  },

  delete(user: AppPolicyUser, project: ProjectWithLanguageNames): boolean {
    return authorize(user, PERMISSIONS.PROJECT_DELETE, {
      orgId: project.organization,
      projectId: project.id,
    });
  },
};
