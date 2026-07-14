export interface PolicyUser {
  id: number;
  grants: any[];
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
    const isManager = user.grants.some(
      (g) =>
        g.orgId === context.organizationId &&
        (g.permissions.has('project:create') || g.permissions.has('project:update'))
    );
    if (isManager) {
      return true;
    }

    if (context.memberUserIds.includes(user.id)) {
      return true;
    }

    return false;
  }
}
