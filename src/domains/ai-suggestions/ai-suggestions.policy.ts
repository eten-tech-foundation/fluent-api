import { ROLES } from '@/lib/roles';

export interface PolicyUser {
  id: number;
  roleName: string;
  organization: number;
}

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
  static canAccessProjectUnit(user: PolicyUser, context: ProjectUnitAuthContext): boolean {
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return context.organizationId === user.organization;
    }

    if (user.roleName === ROLES.TRANSLATOR) {
      return context.memberUserIds.includes(user.id);
    }

    return false;
  }
}
