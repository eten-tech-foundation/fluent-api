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

export const ChapterAssignmentPolicy = {
  edit(
    user: AppPolicyUser,
    assignment: PolicyChapterAssignment,
    _isProjectMember: boolean
  ): boolean {
    const scope = { orgId: assignment.organizationId, projectId: assignment.projectId };

    // Managers (content:assign) may edit only at/after community review.
    if (authorize(user, PERMISSIONS.CONTENT_ASSIGN, scope)) {
      return [
        CHAPTER_ASSIGNMENT_STATUS.COMMUNITY_REVIEW,
        CHAPTER_ASSIGNMENT_STATUS.LINGUIST_CHECK,
        CHAPTER_ASSIGNMENT_STATUS.THEOLOGICAL_CHECK,
        CHAPTER_ASSIGNMENT_STATUS.CONSULTANT_CHECK,
      ].includes(assignment.status as any);
    }

    // Content editors (translators) — assignment-position rules.
    if (!authorize(user, PERMISSIONS.CONTENT_UPDATE, scope)) return false;

    switch (assignment.status) {
      case CHAPTER_ASSIGNMENT_STATUS.DRAFT:
        return assignment.assignedUserId === user.id;
      case CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK:
        return assignment.peerCheckerId === user.id;
      default:
        // By spec, translators can't edit past PEER_CHECK, only managers can.
        return false;
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
    _isProjectMember: boolean
  ): boolean {
    return this.edit(user, assignment, _isProjectMember);
  },

  isParticipant(user: AppPolicyUser, assignment: PolicyChapterAssignment): boolean {
    return assignment.assignedUserId === user.id || assignment.peerCheckerId === user.id;
  },
};
