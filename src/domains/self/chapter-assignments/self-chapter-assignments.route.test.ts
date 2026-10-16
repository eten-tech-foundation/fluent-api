import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserChapterAssignmentResponse } from '@/domains/users/chapter-assignments/users-chapter-assignments.types';
import type { UserProjectResponse } from '@/domains/users/projects/user-projects.types';
import type { UserResponse } from '@/domains/users/users.types';
import type { Permission } from '@/lib/permissions';

import { getChapterAssignmentsByUserId } from '@/domains/projects/chapter-assignments/project-chapter-assignments.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getAllChapterAssignmentsByUserId } from '@/domains/users/chapter-assignments/users-chapter-assignments.service';
import { getProjectsByUserId } from '@/domains/users/projects/user-projects.service';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import './self-chapter-assignments.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: { select: vi.fn(() => mockQueryBuilder), insert: vi.fn(), update: vi.fn() },
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

vi.mock('@/domains/users/projects/user-projects.service', () => ({
  getProjectsByUserId: vi.fn(),
}));

vi.mock('@/domains/projects/chapter-assignments/project-chapter-assignments.service', () => ({
  getChapterAssignmentsByUserId: vi.fn(),
}));

vi.mock('@/domains/users/chapter-assignments/users-chapter-assignments.service', () => ({
  getAllChapterAssignmentsByUserId: vi.fn(),
}));

const APP_USER: UserResponse = {
  id: 1,
  email: 'member@example.com',
  username: 'member',
  firstName: null,
  lastName: null,
  createdBy: null,
  status: 'verified',
  createdAt: null,
  updatedAt: null,
  lastActiveOrgId: null,
};

const zeroCounts = Object.fromEntries(
  [
    'not_started',
    'draft',
    'peer_check',
    'community_review',
    'linguist_check',
    'theological_check',
    'consultant_check',
    'complete',
  ].map((status) => [status, 0])
) as UserProjectResponse['chapterStatusCounts'];

function project(id: number): UserProjectResponse {
  return {
    id,
    name: 'Baka NT',
    organization: 1,
    isActive: true,
    status: 'not_assigned',
    createdBy: 1,
    createdAt: null,
    updatedAt: null,
    metadata: {},
    sourceBibleId: null,
    pericopeSetId: null,
    lastActivityAt: null,
    sourceLanguageId: 1,
    targetLanguageId: 2,
    sourceLanguageName: 'English',
    targetLanguageName: 'Baka',
    sourceName: null,
    lastChapterActivity: null,
    chapterStatusCounts: zeroCounts,
    milestoneCount: 1,
    workflowConfig: [],
  };
}

function chapter(projectId: number, chapterAssignmentId: number): UserChapterAssignmentResponse {
  return {
    chapterAssignmentId,
    projectId,
    projectName: `Project ${projectId}`,
    projectUnitId: projectId,
    bibleId: 1,
    bibleName: 'BSB',
    ttsLicenseStatus: 'unknown',
    textBibleKey: null,
    selectedRecordingKey: null,
    chapterStatus: 'peer_check',
    targetLanguage: 'English',
    targetLangCode: 'eng',
    sourceLangCode: 'eng',
    bookCode: 'MRK',
    bookId: 41,
    book: 'Mark',
    chapterNumber: 1,
    totalVerses: 45,
    completedVerses: 1,
    submittedTime: null,
    assignedUserId: 1,
    peerCheckerId: null,
    updatedAt: null,
    isAiEnabled: false,
    hasClaimConflict: false,
    claimConflictUserId: null,
    hasConflict: false,
  };
}

function asAuthenticatedUser(user: UserResponse = APP_USER, permissions: Permission[] = []) {
  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 's1',
      userId: 'auth-user-1',
      token: 'test-session-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1e9),
    },
    user: {
      id: 'auth-user-1',
      name: user.username,
      email: user.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(ok(user));
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([{ orgId: 1, projectId: null, permissions: new Set(permissions) }])
  );
}

describe('get /self/chapter-assignments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(401);
    expect(getProjectsByUserId).not.toHaveBeenCalled();
    expect(getAllChapterAssignmentsByUserId).not.toHaveBeenCalled();
    expect(getChapterAssignmentsByUserId).not.toHaveBeenCalled();
  });

  it('returns 403 User account is inactive and does not call the service', async () => {
    asAuthenticatedUser({ ...APP_USER, status: 'inactive' });

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'User account is inactive' });
    expect(getProjectsByUserId).not.toHaveBeenCalled();
    expect(getAllChapterAssignmentsByUserId).not.toHaveBeenCalled();
    expect(getChapterAssignmentsByUserId).not.toHaveBeenCalled();
  });

  it('returns 200 { data: [] } from /self/chapter-assignments/all without project:view', async () => {
    asAuthenticatedUser();
    vi.mocked(getChapterAssignmentsByUserId).mockResolvedValue(ok([]));

    const res = await server.request('/self/chapter-assignments/all', { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([]);
    expect(typeof body.syncedAt).toBe('string');
    expect(getChapterAssignmentsByUserId).toHaveBeenCalledWith(1, [], undefined, 1);
  });

  it('forwards excludeProjectIds and updatedAfter on /self/chapter-assignments/all', async () => {
    asAuthenticatedUser();
    vi.mocked(getChapterAssignmentsByUserId).mockResolvedValue(ok([]));

    const res = await server.request(
      '/self/chapter-assignments/all?excludeProjectIds=97,98&updatedAfter=2025-01-01T00:00:00.000Z',
      { method: 'GET' }
    );

    expect(res.status).toBe(200);
    expect(getChapterAssignmentsByUserId).toHaveBeenCalledWith(
      1,
      [97, 98],
      new Date('2025-01-01T00:00:00.000Z'),
      1
    );
  });

  it.each(['abc', '1,abc,2', '0', '-1', '1.5', '01', '97, 98', ''])(
    'returns 400 when excludeProjectIds is %j on /self/chapter-assignments/all',
    async (excludeProjectIds) => {
      asAuthenticatedUser();

      const res = await server.request(
        `/self/chapter-assignments/all?excludeProjectIds=${encodeURIComponent(excludeProjectIds)}`,
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(getChapterAssignmentsByUserId).not.toHaveBeenCalled();
    }
  );

  it('returns 200 empty assigned and peer-check chapters from /self/chapter-assignments', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));
    vi.mocked(getAllChapterAssignmentsByUserId).mockResolvedValue(
      ok({ assignedChapters: [], peerCheckChapters: [] })
    );

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignedChapters: [], peerCheckChapters: [] });
    expect(getProjectsByUserId).toHaveBeenCalledWith(1, 1);
    expect(getAllChapterAssignmentsByUserId).toHaveBeenCalledWith(1, 1);
  });

  it('drops chapters from projects the caller has left', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([]));
    vi.mocked(getAllChapterAssignmentsByUserId).mockResolvedValue(
      ok({
        assignedChapters: [chapter(1, 10)],
        peerCheckChapters: [chapter(1, 11)],
      })
    );

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignedChapters: [], peerCheckChapters: [] });
  });

  it('keeps chapters only for projects the caller still belongs to', async () => {
    asAuthenticatedUser();
    const kept = chapter(2, 20);
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([project(2)]));
    vi.mocked(getAllChapterAssignmentsByUserId).mockResolvedValue(
      ok({
        assignedChapters: [chapter(1, 10), kept],
        peerCheckChapters: [chapter(1, 11)],
      })
    );

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignedChapters: [kept], peerCheckChapters: [] });
  });

  it('returns the projects error when both services fail', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    vi.mocked(getAllChapterAssignmentsByUserId).mockResolvedValue(
      err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND)
    );

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'An unexpected error occurred' });
  });

  it('returns the chapter-assignments error when projects succeed', async () => {
    asAuthenticatedUser();
    vi.mocked(getProjectsByUserId).mockResolvedValue(ok([project(2)]));
    vi.mocked(getAllChapterAssignmentsByUserId).mockResolvedValue(
      err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND)
    );

    const res = await server.request('/self/chapter-assignments', { method: 'GET' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Chapter assignment not found' });
  });
});
