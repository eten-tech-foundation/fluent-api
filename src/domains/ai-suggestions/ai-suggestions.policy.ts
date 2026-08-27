import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

export interface ProjectUnitAuthContext {
  organizationId: number;
  projectId: number;
}

export class AiSuggestionsPolicy {
  /**
   * Determines if a user can access AI suggestions for a specific project unit.
   * Checks if the user has project view or content update permissions within the project scope.
   */
  static canAccessProjectUnit(user: AppPolicyUser, context: ProjectUnitAuthContext): boolean {
    const scope = { orgId: context.organizationId, projectId: context.projectId };
    return (
      authorize(user, PERMISSIONS.PROJECT_VIEW, scope) ||
      authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)
    );
  }
}
