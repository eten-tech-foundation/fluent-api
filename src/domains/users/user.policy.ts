import type { AppPolicyUser } from '@/lib/types';

import { ROLES } from '@/lib/roles';

interface PolicyTargetUser {
  id: number;
  organization: number;
}

export const UserPolicy = {
  /**
   * Can this user list all users in the organization?
   *
   * Manager    : yes.
   * Translator : no (they can only view themselves via their specific ID).
   */
  list(user: AppPolicyUser): boolean {
    return user.roleName === ROLES.PROJECT_MANAGER;
  },

  /**
   * Can this user view the target user's profile?
   *
   * Manager    : yes, if the target is in the same organisation.
   * Translator : yes, only if the target is themselves.
   */
  view(user: AppPolicyUser, targetUser: PolicyTargetUser): boolean {
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return user.organization === targetUser.organization;
    }

    if (user.roleName === ROLES.TRANSLATOR) {
      return user.id === targetUser.id;
    }

    return false;
  },

  /**
   * Can this user create a new user?
   *
   * Manager    : yes — requirePermission already confirmed user:create.
   * Translator : never reaches here, blocked by requirePermission.
   */
  create(user: AppPolicyUser): boolean {
    return user.roleName === ROLES.PROJECT_MANAGER;
  },

  /**
   * Can this user update the target user's profile?
   *
   * Manager    : yes, if the target is in the same organisation.
   * Translator : yes, only if the target is themselves.
   *
   * Note: role and organisation fields are stripped from updates
   * for non-managers in the handler before this is called.
   */
  update(user: AppPolicyUser, targetUser: PolicyTargetUser): boolean {
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return user.organization === targetUser.organization;
    }

    if (user.roleName === ROLES.TRANSLATOR) {
      return user.id === targetUser.id;
    }

    return false;
  },

  /**
   * Can this user delete a user?
   *
   * Manager    : yes, if the target is in the same organisation.
   * Translator : never reaches here, blocked by requirePermission.
   */
  delete(user: AppPolicyUser, targetUser: PolicyTargetUser): boolean {
    if (user.roleName === ROLES.PROJECT_MANAGER) {
      return user.organization === targetUser.organization;
    }

    return false;
  },
};
