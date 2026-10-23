/**
 * src/domains/chapter-assignments/chapter-assignment.policy.ts
 *
 * Record-level access rules for chapter assignments.
 * Now includes strict Organization-level multi-tenant isolation.
 */

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';
import { authorize } from '@/lib/services/permissions/authorize';

import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

export interface PolicyChapterAssignment {
  organizationId: number;
  projectId: number;
  assignedUserId?: number | null;
  peerCheckerId?: number | null;
  status?: string | null;
}

/** Same-user claim retry is only idempotent while the row is still DRAFT. */
export function isIdempotentSelfClaim(
  assignment: Pick<PolicyChapterAssignment, 'assignedUserId' | 'status'>,
  userId: number
): boolean {
  return (
    assignment.assignedUserId === userId && assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT
  );
}

/** Rival held work may be conflict-flagged only while not terminal (complete). */
function isClaimConflictEligibleStatus(status: string | null | undefined): boolean {
  return status != null && status !== CHAPTER_ASSIGNMENT_STATUS.COMPLETE;
}

export function isPostPeerStatus(
  status: string | null | undefined,
  stages: Array<{ defaultName: string }>
): boolean {
  if (!status || !stages || stages.length === 0) return false;
  const peerIdx = stages.findIndex((s) => s.defaultName === CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
  const completeIdx = stages.findIndex((s) => s.defaultName === CHAPTER_ASSIGNMENT_STATUS.COMPLETE);
  const currentIdx = stages.findIndex((s) => s.defaultName === status);
  if (peerIdx !== -1 && completeIdx !== -1 && currentIdx !== -1) {
    return currentIdx > peerIdx && currentIdx < completeIdx;
  }
  return false;
}

export const ChapterAssignmentPolicy = {
  edit(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    isProjectMember: boolean,
    stages: Array<{ defaultName: string }>
  ): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    const isPostPeer = isPostPeerStatus(assignment.status, stages);

    // Managers (content:assign) may edit only at/after peer check (post-peer stages).
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return isPostPeer;
    }

    // Content editors (translators) — assignment-position rules.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;

    switch (assignment.status) {
      case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
        return assignment.assignedUserId === user.id;
      case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
        if (assignment.peerCheckerId != null) {
          return assignment.peerCheckerId === user.id;
        }
        return (
          isProjectMember &&
          assignment.assignedUserId != null &&
          assignment.assignedUserId !== user.id
        );
      default:
        return isPostPeer && isProjectMember;
    }
  },

  resolveAudioConflict(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };
    return authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope);
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
    isProjectMember: boolean,
    stages: Array<{ defaultName: string }>
  ): boolean {
    return this.edit(user, assignment, isProjectMember, stages);
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
    isProjectMember: boolean,
    stages: Array<{ defaultName: string }>
  ): boolean {
    // A participant in the editor is exactly anyone who currently has edit rights.
    return this.edit(user, assignment, isProjectMember, stages);
  },

  claim(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };

    // Managers (content:assign) assign via PATCH .../:id, not via claim.
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) return false;

    // Translators have content:update without content:assign.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;

    // Same translator retrying their own claim (e.g. offline reconnect) — service
    // returns idempotently without duplicating history. Same-user non-DRAFT → 404.
    if (assignment.assignedUserId === user.id) {
      return isIdempotentSelfClaim(assignment, user.id);
    }

    // Another user holds non-terminal work (DRAFT race, late reconnect, PM assign,
    // or a later non-complete stage). Service returns conflict-shaped 200 and
    // latches hasClaimConflict / first claimConflictUserId without changing
    // assignedUserId (#376). Terminal (complete) work is not flaggable.
    if (assignment.assignedUserId != null) {
      return isClaimConflictEligibleStatus(assignment.status);
    }

    return (
      assignment.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED &&
      assignment.assignedUserId == null
    );
  },
};
