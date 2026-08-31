import { describe, expect, it } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';

import { ChapterAssignmentPolicy } from './chapter-assignments.policy';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const grant = (orgId: number, projectId: number, perms: string[]): AppPolicyUser => ({
  id: 1,
  grants: [{ orgId, projectId, permissions: new Set(perms) as ReadonlySet<any> }],
});

const baseAssignment = {
  organizationId: 1,
  projectId: 10,
  assignedUserId: null as number | null,
  peerCheckerId: null as number | null,
  status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
};

describe('chapterAssignmentPolicy.claim', () => {
  it('allows a translator with content:update on an unassigned not_started chapter', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(ChapterAssignmentPolicy.claim(user, baseAssignment)).toBe(true);
  });

  it('denies a PM/org manager with content:assign', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_ASSIGN, PERMISSIONS.CONTENT_UPDATE]);
    expect(ChapterAssignmentPolicy.claim(user, baseAssignment)).toBe(false);
  });

  it('denies a user without content:update', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_VIEW]);
    expect(ChapterAssignmentPolicy.claim(user, baseAssignment)).toBe(false);
  });

  it('allows idempotent retry when the same translator already owns the draft', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: user.id,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      })
    ).toBe(true);
  });

  it('allows a race loser when another translator recently claimed a draft without peer', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        peerCheckerId: null,
        updatedAt: new Date(),
      })
    ).toBe(true);
  });

  it('denies a late claim on a stale peer draft (not a real race)', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    const staleClaim = new Date(Date.now() - 6 * 60 * 1000);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        peerCheckerId: null,
        updatedAt: staleClaim,
      })
    ).toBe(false);
  });

  it('denies when the chapter is already assigned to someone else with a peer checker (PM assign)', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        peerCheckerId: 88,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      })
    ).toBe(false);
  });

  it('denies when the chapter is not in not_started status', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      })
    ).toBe(false);
  });
});
