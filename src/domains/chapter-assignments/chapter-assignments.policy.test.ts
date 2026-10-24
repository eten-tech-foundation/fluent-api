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

  it('denies same-user claim when status is no longer DRAFT', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: user.id,
        peerCheckerId: 88,
        status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
      })
    ).toBe(false);
  });

  it('allows a race loser when another translator claimed a draft without peer', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        peerCheckerId: null,
      })
    ).toBe(true);
  });

  it('allows a late reconnect claim on a draft held by another translator', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        peerCheckerId: null,
      })
    ).toBe(true);
  });

  it('allows claim when the chapter is assigned to someone else with a peer checker (PM assign)', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        peerCheckerId: 88,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      })
    ).toBe(true);
  });

  it('allows a conflict-shaped claim when another user holds a non-DRAFT assignment', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        peerCheckerId: 88,
        status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
      })
    ).toBe(true);
  });

  it('denies conflict claim when another user holds complete/terminal work', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(
      ChapterAssignmentPolicy.claim(user, {
        ...baseAssignment,
        assignedUserId: 99,
        peerCheckerId: 88,
        status: CHAPTER_ASSIGNMENT_STATUS.COMPLETE,
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

describe('chapterAssignmentPolicy.resetStatus', () => {
  it('allows a manager with content:assign at project scope', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_ASSIGN]);
    expect(ChapterAssignmentPolicy.resetStatus(user, 1, 10)).toBe(true);
  });

  it('denies a translator with only content:update', () => {
    const user = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE]);
    expect(ChapterAssignmentPolicy.resetStatus(user, 1, 10)).toBe(false);
  });
});

describe('chapterAssignmentPolicy.edit / submit — open Peer Check', () => {
  const openPeerCheck = {
    ...baseAssignment,
    assignedUserId: 42,
    peerCheckerId: null,
    status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
  };

  const defaultStages = [
    { defaultName: 'not_started' },
    { defaultName: 'draft' },
    { defaultName: 'peer_check' },
    { defaultName: 'community_review' },
    { defaultName: 'complete' },
  ];

  it('allows a project member with content:update who is not the drafter', () => {
    const peer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(peer, openPeerCheck, true, defaultStages)).toBe(true);
    expect(ChapterAssignmentPolicy.submit(peer, openPeerCheck, true, defaultStages)).toBe(true);
  });

  it('denies the drafter on open Peer Check', () => {
    const drafter = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 42);
    expect(ChapterAssignmentPolicy.edit(drafter, openPeerCheck, true, defaultStages)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(drafter, openPeerCheck, true, defaultStages)).toBe(false);
  });

  it('denies a content:update user who is not a project member', () => {
    const outsider = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(outsider, openPeerCheck, false, defaultStages)).toBe(false);
  });

  it('keeps PM exclusivity when peerCheckerId is already set', () => {
    const assignedChecker = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 88);
    const otherPeer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    const assigned = { ...openPeerCheck, peerCheckerId: 88 };

    expect(ChapterAssignmentPolicy.edit(assignedChecker, assigned, true, defaultStages)).toBe(true);
    expect(ChapterAssignmentPolicy.edit(otherPeer, assigned, true, defaultStages)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(otherPeer, assigned, true, defaultStages)).toBe(false);
  });

  it('does not let a content:assign manager use translator Peer Check rules', () => {
    const manager = grant(1, 10, [PERMISSIONS.CONTENT_ASSIGN, PERMISSIONS.CONTENT_UPDATE], 7);
    expect(ChapterAssignmentPolicy.edit(manager, openPeerCheck, true, defaultStages)).toBe(false);
  });

  it('denies open Peer Check when assignedUserId is missing (inconsistent data)', () => {
    const peer = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 7);
    const inconsistent = {
      ...openPeerCheck,
      assignedUserId: null,
    };

    expect(ChapterAssignmentPolicy.edit(peer, inconsistent, true, defaultStages)).toBe(false);
    expect(ChapterAssignmentPolicy.submit(peer, inconsistent, true, defaultStages)).toBe(false);
  });
});

describe('chapterAssignmentPolicy.edit / submit — post-peer and custom stages', () => {
  const customAssignment = {
    ...baseAssignment,
    assignedUserId: 42,
    peerCheckerId: 7,
    status: 'custom_review_1',
  };

  const stages = [
    { defaultName: 'not_started' },
    { defaultName: 'draft' },
    { defaultName: 'peer_check' },
    { defaultName: 'custom_review_1' },
    { defaultName: 'complete' },
  ];

  const manager = grant(1, 10, [PERMISSIONS.CONTENT_ASSIGN], 99);
  const translator = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 42);
  const outsiderTranslator = grant(1, 10, [PERMISSIONS.CONTENT_UPDATE], 42);

  it('allows manager (content:assign) to edit and submit in custom stage when stages provided', () => {
    expect(ChapterAssignmentPolicy.edit(manager, customAssignment, true, stages)).toBe(true);
    expect(ChapterAssignmentPolicy.submit(manager, customAssignment, true, stages)).toBe(true);
  });

  it('allows project member translator to edit and submit in custom stage when stages provided', () => {
    expect(ChapterAssignmentPolicy.edit(translator, customAssignment, true, stages)).toBe(true);
    expect(ChapterAssignmentPolicy.submit(translator, customAssignment, true, stages)).toBe(true);
  });

  it('denies translator who is not a project member in custom stage', () => {
    expect(ChapterAssignmentPolicy.edit(outsiderTranslator, customAssignment, false, stages)).toBe(
      false
    );
    expect(
      ChapterAssignmentPolicy.submit(outsiderTranslator, customAssignment, false, stages)
    ).toBe(false);
  });

  it('denies edit in custom stage when stages are absent or stage is unlisted', () => {
    expect(ChapterAssignmentPolicy.edit(manager, customAssignment, true, [])).toBe(false);
    const unlistedAssignment = { ...customAssignment, status: 'unknown_custom_stage' };
    expect(ChapterAssignmentPolicy.edit(manager, unlistedAssignment, true, stages)).toBe(false);
  });
});
