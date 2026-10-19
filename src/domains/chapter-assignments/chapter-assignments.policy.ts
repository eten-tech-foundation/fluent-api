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
  updatedAt?: Date | null;
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
    // returns idempotently without duplicating history.
    if (assignment.assignedUserId === user.id) {
      return assignment.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT;
    }

    // Another user holds the chapter at any status (DRAFT race, late reconnect,
    // PM assign, or a later workflow stage). Service returns the conflict-shaped
    // 200 and records hasClaimConflict without overwriting assignedUserId (#376).
    // Same-user non-DRAFT stays denied above. content:assign and missing
    // content:update stay denied above — permissions are unchanged.
    if (assignment.assignedUserId != null) {
      return true;
    }

    return (
      assignment.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED &&
      assignment.assignedUserId == null
    );
  },
};
