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
