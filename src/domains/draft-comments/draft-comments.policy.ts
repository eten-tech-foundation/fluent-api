/**
 * Scoped grant checks for draft chapter comments (#458).
 * Uses authorize() + project scope — never role-name labels alone.
 * Seed maps comment:write to Observer / Translator / Project Manager (SOURCE only).
 */
import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

interface DraftCommentPolicyScope {
  organizationId: number;
  projectId: number;
}

export const DraftCommentPolicy = {
  /** List + aggregate: project-scoped content:view (or membership at route layer). */
  read(user: AppPolicyUser, scope: DraftCommentPolicyScope): boolean {
    return authorize(user, PERMISSIONS.CONTENT_VIEW, {
      orgId: scope.organizationId,
      projectId: scope.projectId,
    });
  },

  /**
   * Create / reply / react / comment-audio: requires comment:write on the project.
   * Distinct from content:update — Observers must not gain draft edit via this path.
   */
  write(user: AppPolicyUser, scope: DraftCommentPolicyScope): boolean {
    return authorize(user, PERMISSIONS.COMMENT_WRITE, {
      orgId: scope.organizationId,
      projectId: scope.projectId,
    });
  },
};
