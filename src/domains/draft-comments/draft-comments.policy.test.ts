import { describe, expect, it } from 'vitest';

import type { AppPolicyUser, Grant } from '@/lib/types';

import { PERMISSIONS } from '@/lib/permissions';

import { DraftCommentPolicy } from './draft-comments.policy';

function userWith(grants: Grant[]): AppPolicyUser {
  return { id: 7, grants };
}

const scope = { organizationId: 1, projectId: 10 };

describe('draftCommentPolicy', () => {
  it('read allows project-scoped content:view', () => {
    const user = userWith([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW]),
      },
    ]);
    expect(DraftCommentPolicy.read(user, scope)).toBe(true);
  });

  it('read denies when grant is for a different project', () => {
    const user = userWith([
      {
        orgId: 1,
        projectId: 99,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ]);
    expect(DraftCommentPolicy.read(user, scope)).toBe(false);
  });

  it('write requires comment:write — content:update alone is insufficient', () => {
    const translatorLike = userWith([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([
          PERMISSIONS.PROJECT_VIEW,
          PERMISSIONS.CONTENT_VIEW,
          PERMISSIONS.CONTENT_UPDATE,
        ]),
      },
    ]);
    expect(DraftCommentPolicy.write(translatorLike, scope)).toBe(false);
  });

  it('write allows project-scoped comment:write without content:update (Observer-shaped)', () => {
    const observerLike = userWith([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([
          PERMISSIONS.PROJECT_VIEW,
          PERMISSIONS.CONTENT_VIEW,
          PERMISSIONS.COMMENT_WRITE,
        ]),
      },
    ]);
    expect(DraftCommentPolicy.write(observerLike, scope)).toBe(true);
    expect(DraftCommentPolicy.read(observerLike, scope)).toBe(true);
  });

  it('write denies content:view alone (read is not write)', () => {
    const viewer = userWith([
      {
        orgId: 1,
        projectId: 10,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW]),
      },
    ]);
    expect(DraftCommentPolicy.write(viewer, scope)).toBe(false);
  });
});
