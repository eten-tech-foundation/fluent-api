import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

export interface ProjectUnitAuthContext {
  organizationId: number;
  memberUserIds: number[];
}

export class AiSuggestionsPolicy {
  /**
   * Determines if a user can access AI suggestions for a specific project unit.
   * Project Managers can access if they belong to the same organization.
   * Translators can access if they are assigned as a member of the project.
   */
  static canAccessProjectUnit(user: AppPolicyUser, context: ProjectUnitAuthContext): boolean {
    const scope = { orgId: context.organizationId, projectId: null };
    const isManager =
      authorize(user, PERMISSIONS.PROJECT_CREATE, scope) ||
      authorize(user, PERMISSIONS.PROJECT_UPDATE, scope);

    if (isManager) {
      return true;
    }

    if (context.memberUserIds.includes(user.id)) {
      return true;
    }

    return false;
  }
}
