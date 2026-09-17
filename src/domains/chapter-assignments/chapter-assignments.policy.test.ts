import { describe, expect, it } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';

import { ChapterAssignmentPolicy } from './chapter-assignments.policy';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const grant = (orgId: number, projectId: number, perms: string[], id = 1): AppPolicyUser => ({
  id,
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

describe('chapterAssignmentPolicy.edit / submit — open Peer Check', () => {
  const openPeerCheck = {
    ...baseAssignment,
    assignedUserId: 42,
    peerCheckerId: null,
    status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
  };

  it('allows a project member with content:update who is not the drafter', () => {
    const peer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(peer, openPeerCheck, true)).toBe(true);
    expect(ChapterAssignmentPolicy.submit(peer, openPeerCheck, true)).toBe(true);
  });

  it('denies the drafter on open Peer Check', () => {
    const drafter = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 42);
    expect(ChapterAssignmentPolicy.edit(drafter, openPeerCheck, true)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(drafter, openPeerCheck, true)).toBe(false);
  });

  it('denies a content:update user who is not a project member', () => {
    const outsider = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(outsider, openPeerCheck, false)).toBe(false);
  });

  it('keeps PM exclusivity when peerCheckerId is already set', () => {
    const assignedChecker = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 88);
    const otherPeer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    const assigned = { ...openPeerCheck, peerCheckerId: 88 };

    expect(ChapterAssignmentPolicy.edit(assignedChecker, assigned, true)).toBe(true);
    expect(ChapterAssignmentPolicy.edit(otherPeer, assigned, true)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(otherPeer, assigned, true)).toBe(false);
  });

  it('does not let a content:assign manager use translator Peer Check rules', () => {
    const manager = grant(1, 10, [PERMISSIONS.CONTENT_ASSIGN, PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(manager, openPeerCheck, true)).toBe(false);
  });

  it('denies open Peer Check when assignedUserId is missing (inconsistent data)', () => {
    const peer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    const inconsistent = {
      ...openPeerCheck,
      assignedUserId: null,
    };

    expect(ChapterAssignmentPolicy.edit(peer, inconsistent, true)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(peer, inconsistent, true)).toBe(false);
  });
});
