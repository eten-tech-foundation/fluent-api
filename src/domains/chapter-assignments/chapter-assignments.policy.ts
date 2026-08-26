/**
 * src/domains/chapter-assignments/chapter-assignment.policy.ts
 *
 * Record-level access rules for chapter assignments.
 * Now includes strict Organization-level multi-tenant isolation.
 */

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

import { CHAPTER_ASSIGNMENT_STATUS, CLAIM_RACE_WINDOW_MS } from './chapter-assignments.types';

export interface PolicyChapterAssignment {
  organizationId: number;
  projectId: number;
  assignedUserId?: number | null;
  peerCheckerId?: number | null;
  status?: string | null;
  updatedAt?: Date | null;
}

function isWithinClaimRaceWindow(updatedAt: Date | null | undefined, now = Date.now()): boolean {
  if (!updatedAt) return false;
  return now - updatedAt.getTime() <= CLAIM_RACE_WINDOW_MS;
}

const POST_PEER_STATUSES = new Set<string>([
  CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
  CHAPTER_ASSIGNMENT_STATUS.LINGUIST_CHECK,
  CHAPTER_ASSIGNMENT_STATUS.THEOLOGICAL_CHECK,
  CHAPTER_ASSIGNMENT_STATUS.CONSULTANT_CHECK,
]);

export const ChapterAssignmentPolicy = {
  edit(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    isProjectMember: boolean
  ): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };

    // Managers (content:assign) may edit only at/after community review.
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return POST_PEER_STATUSES.has(assignment.status as any);
    }

    // Content editors (translators) — assignment-position rules.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;

    switch (assignment.status) {
      case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
        return assignment.assignedUserId === user.id;
      case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
        return assignment.peerCheckerId === user.id;
      default:
        return POST_PEER_STATUSES.has(assignment.status as any) && isProjectMember;
    }
  },

  create(user: AppPolicyUser, targetOrganizationId: number, targetProjectId: number): boolean {
    const scope = { orgId: targetOrganizationId, projectId: targetProjectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  deleteAll(user: AppPolicyUser, targetOrganizationId: number, targetProjectId: number): boolean {
    const scope = { orgId: targetOrganizationId, projectId: targetProjectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  assignAll(user: AppPolicyUser, targetOrganizationId: number, targetProjectId: number): boolean {
    const scope = { orgId: targetOrganizationId, projectId: targetProjectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  view(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    isProjectMember: boolean
  ): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    return authorize(user, PERMISSIONS.CONTENT_VIEW, scope) || isProjectMember;
  },

  update(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  delete(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  assign(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
  },

  submit(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    isProjectMember: boolean
  ): boolean {
    return this.edit(user, assignment, isProjectMember);
  },

  /**
   * Can this user toggle AI for this assignment?
   */
  toggleAi(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };

    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return true;
    }

    if (authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) {
      if (assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT) {
        return assignment.assignedUserId === user.id;
      }
    }

    return false;
  },

  isParticipant(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    isProjectMember: boolean = false
  ): boolean {
    // A participant in the editor is exactly anyone who currently has edit rights.
    return this.edit(user, assignment, isProjectMember);
  },

  claim(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };

    // Managers (content:assign) assign via PATCH .../:id, not via claim.
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) return false;

    // Translators have content:update without content:assign.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;

    // Same translator retrying their own claim (e.g. offline reconnect) — service
    // returns idempotently without duplicating history.
    if (assignment.assignedUserId === user.id) {
      return assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT;
    }

    // Another translator won a recent self-claim (true race / retry overlap).
    // Service flags hasClaimConflict and returns 200 — never 404 for concurrency.
    // Stale drafts are not claimable; offline reconnect conflicts are detected
    // client-side during assignment sync (#271), not via this branch.
    if (assignment.assignedUserId != null) {
      return (
        assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT &&
        assignment.peerCheckerId == null &&
        isWithinClaimRaceWindow(assignment.updatedAt)
      );
    }

    return (
      assignment.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED &&
      assignment.assignedUserId == null
    );
  },
};
