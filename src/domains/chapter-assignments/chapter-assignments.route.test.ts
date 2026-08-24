import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { server } from '@/server/server';

import * as chapterAssignmentService from './chapter-assignments.service';
import './chapter-assignments.route';

const { allowClaimAccess } = vi.hoisted(() => ({
  allowClaimAccess: { value: true },
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    groupBy: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    as: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
      selectDistinct: vi.fn(() => mockQueryBuilder),
      insert: vi.fn(() => mockQueryBuilder),
      update: vi.fn(() => mockQueryBuilder),
      delete: vi.fn(() => mockQueryBuilder),
      transaction: vi.fn(),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('./chapter-assignment-auth.middleware', () => ({
  requireChapterAssignmentAccess: vi.fn(() => async (c: any, next: any) => {
    if (!allowClaimAccess.value) {
      return c.json({ message: 'Chapter assignment not found' }, 404);
    }
    return next();
  }),
}));

vi.mock('./chapter-assignments.service', () => ({
  getChapterAssignmentWithAuthContext: vi.fn(),
  claimChapterAssignment: vi.fn(),
  toChapterAssignmentResponse: vi.fn((record) => record),
}));

const TRANSLATOR = {
  id: 10,
  email: 'translator@example.com',
  status: 'verified' as const,
};

const PM = {
  id: 20,
  email: 'pm@example.com',
  status: 'verified' as const,
};

function asUser(user: typeof TRANSLATOR, permissions: string[]) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: { ...user, grants: [] } });
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: [{ orgId: 1, projectId: 1, permissions: new Set(permissions) }],
  });
}

function claimChapter(chapterAssignmentId: number) {
  return server.request(`/chapter-assignments/${chapterAssignmentId}/claim`, {
    method: 'POST',
  });
}

describe('pOST /chapter-assignments/:id/claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    allowClaimAccess.value = true;
  });

  it('returns 401 when unauthenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    const res = await claimChapter(1);
    expect(res.status).toBe(401);
  });

  it('returns 200 with draft assignment when translator claims successfully', async () => {
    asUser(TRANSLATOR, [PERMISSIONS.CONTENT_UPDATE]);
    (chapterAssignmentService.claimChapterAssignment as any).mockResolvedValue({
      ok: true,
      data: {
        id: 1,
        projectUnitId: 1,
        bibleId: 1,
        bookId: 1,
        chapterNumber: 1,
        assignedUserId: 10,
        peerCheckerId: null,
        status: 'draft',
        submittedTime: null,
        hasClaimConflict: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await claimChapter(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.assignedUserId).toBe(10);
    expect(body.status).toBe('draft');
    expect(body.hasClaimConflict).toBe(false);
    expect(chapterAssignmentService.claimChapterAssignment).toHaveBeenCalledWith(1, 10);
  });

  it('returns 200 with hasClaimConflict when another user won the race', async () => {
    asUser(TRANSLATOR, [PERMISSIONS.CONTENT_UPDATE]);
    (chapterAssignmentService.claimChapterAssignment as any).mockResolvedValue({
      ok: true,
      data: {
        id: 1,
        projectUnitId: 1,
        bibleId: 1,
        bookId: 1,
        chapterNumber: 1,
        assignedUserId: 99,
        peerCheckerId: null,
        status: 'draft',
        submittedTime: null,
        hasClaimConflict: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await claimChapter(1);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasClaimConflict).toBe(true);
  });

  it('returns 404 when chapter is already assigned to someone else (policy blocks)', async () => {
    asUser(TRANSLATOR, [PERMISSIONS.CONTENT_UPDATE]);
    allowClaimAccess.value = false;

    const res = await claimChapter(1);
    expect(res.status).toBe(404);
    expect(chapterAssignmentService.claimChapterAssignment).not.toHaveBeenCalled();
  });

  it('returns 404 when a PM with content:assign tries to claim', async () => {
    asUser(PM, [PERMISSIONS.CONTENT_ASSIGN, PERMISSIONS.CONTENT_UPDATE]);
    allowClaimAccess.value = false;

    const res = await claimChapter(1);
    expect(res.status).toBe(404);
    expect(chapterAssignmentService.claimChapterAssignment).not.toHaveBeenCalled();
  });
});
