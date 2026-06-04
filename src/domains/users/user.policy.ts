import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

export interface PolicyTargetUser {
  id: number;
  orgIds: number[];
}

export const UserPolicy = {
  list(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.USER_VIEW));
  },

  create(user: AppPolicyUser): boolean {
    return user.grants.some((g) => g.permissions.has(PERMISSIONS.USER_CREATE));
  },

  view(user: AppPolicyUser, target: PolicyTargetUser): boolean {
    if (user.id === target.id) return true;
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_VIEW, { orgId }));
  },

  update(user: AppPolicyUser, target: PolicyTargetUser): boolean {
    if (user.id === target.id) return true;
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_UPDATE, { orgId }));
  },

  delete(user: AppPolicyUser, target: PolicyTargetUser): boolean {
    // Full account deletion is SuperAdmin-only (no role is seeded user:delete). Deferred otherwise.
    return target.orgIds.some((orgId) => authorize(user, PERMISSIONS.USER_DELETE, { orgId }));
  },
};
