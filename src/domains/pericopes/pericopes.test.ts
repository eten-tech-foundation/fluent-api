import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/services/permissions/permissions.service';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as repo from './pericopes.repository';

import '@/domains/pericopes/pericopes.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/lib/services/permissions/permissions.service', () => ({
  roleHasPermission: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./pericopes.repository', () => ({
  getAllPericopeSets: vi.fn(),
  getPericopeSetIdForProject: vi.fn(),
  getBookIdByCode: vi.fn(),
  getPericopeVersesForChapter: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'Translator',
  organization: 1,
  status: 'verified' as 'verified' | 'inactive',
};

const MOCK_PROJECT = {
  id: 10,
  name: 'Test Project',
  organization: 1,
};

function asAuthenticatedUser(overrides: Partial<typeof APP_USER> = {}, grantedPermission = true) {
  const user = { ...APP_USER, ...overrides };
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(user));
  (roleHasPermission as any).mockResolvedValue(grantedPermission);
}

describe('pericopes router & service integrations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── GET /pericope-sets ─────────────────────────────────────────────────────

  describe('gET /pericope-sets', () => {
    it('returns 401 when the user is not authenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request('/pericope-sets', { method: 'GET' });

      expect(res.status).toBe(401);
      expect(repo.getAllPericopeSets).not.toHaveBeenCalled();
    });

    it('returns 403 when the user account is inactive', async () => {
      asAuthenticatedUser({ status: 'inactive' });

      const res = await server.request('/pericope-sets', { method: 'GET' });

      expect(res.status).toBe(403);
      expect(repo.getAllPericopeSets).not.toHaveBeenCalled();
    });

    it('returns 200 and list of pericope sets on success', async () => {
      asAuthenticatedUser();
      const mockSets = [
        { id: 1, name: 'FIA', description: 'Familiarization, Internalization, Articulation' },
      ];
      vi.mocked(repo.getAllPericopeSets).mockResolvedValue(mockSets);

      const res = await server.request('/pericope-sets', { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(mockSets);
      expect(repo.getAllPericopeSets).toHaveBeenCalledOnce();
    });

    it('returns 500 when repository throws on listPericopeSets', async () => {
      asAuthenticatedUser();
      vi.mocked(repo.getAllPericopeSets).mockRejectedValue(new Error('Database error'));

      const res = await server.request('/pericope-sets', { method: 'GET' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'An unexpected error occurred' });
    });
  });

  // ─── GET /projects/:id/pericopes/:bookCode/:chapter ─────────────────────────

  describe('gET /projects/:id/pericopes/:bookCode/:chapter', () => {
    it('returns 401 when the user is not authenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(401);
      expect(repo.getPericopeSetIdForProject).not.toHaveBeenCalled();
    });

    it('returns 403 when user lacks PROJECT_VIEW permission', async () => {
      asAuthenticatedUser({}, false);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(403);
      expect(repo.getPericopeSetIdForProject).not.toHaveBeenCalled();
    });

    it('returns 404 if project is not found', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(err(ErrorCode.PROJECT_NOT_FOUND));

      const res = await server.request('/projects/999/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(404);
      expect(repo.getPericopeSetIdForProject).not.toHaveBeenCalled();
    });

    it('returns 404 when project member check fails (forbidden)', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(false);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
      expect(repo.getPericopeSetIdForProject).not.toHaveBeenCalled();
    });

    it('returns 400 if project ID parameter is missing or invalid', async () => {
      asAuthenticatedUser();

      const res = await server.request('/projects/invalid-id/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'Missing project ID' });
      expect(repo.getPericopeSetIdForProject).not.toHaveBeenCalled();
    });

    it('returns 200 and empty list if project has no pericope set', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
      vi.mocked(repo.getPericopeSetIdForProject).mockResolvedValue(null);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(repo.getPericopeSetIdForProject).toHaveBeenCalledWith(10);
      expect(repo.getBookIdByCode).not.toHaveBeenCalled();
    });

    it('returns 404 if book code is not resolved to a book ID', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
      vi.mocked(repo.getPericopeSetIdForProject).mockResolvedValue(2);
      vi.mocked(repo.getBookIdByCode).mockResolvedValue(null);

      const res = await server.request('/projects/10/pericopes/INVALID_BOOK/1', { method: 'GET' });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Book not found' });
      expect(repo.getBookIdByCode).toHaveBeenCalledWith('INVALID_BOOK');
      expect(repo.getPericopeVersesForChapter).not.toHaveBeenCalled();
    });

    it('returns 200 and empty list if no pericope verses exist for chapter', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
      vi.mocked(repo.getPericopeSetIdForProject).mockResolvedValue(2);
      vi.mocked(repo.getBookIdByCode).mockResolvedValue(43);
      vi.mocked(repo.getPericopeVersesForChapter).mockResolvedValue([]);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(repo.getPericopeVersesForChapter).toHaveBeenCalledWith(2, 43, 1);
    });

    it('returns 200 and grouped pericopes array when data exists', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
      vi.mocked(repo.getPericopeSetIdForProject).mockResolvedValue(2);
      vi.mocked(repo.getBookIdByCode).mockResolvedValue(43);

      const mockVerses = [
        {
          chapterNumber: 1,
          verseNumber: 1,
          pericopeNumber: '1',
          pericopeTitle: 'The Word Became Flesh',
        },
        {
          chapterNumber: 1,
          verseNumber: 2,
          pericopeNumber: '1',
          pericopeTitle: 'The Word Became Flesh',
        },
        {
          chapterNumber: 1,
          verseNumber: 3,
          pericopeNumber: '2',
          pericopeTitle: 'John the Baptist Denies Being the Messiah',
        },
        {
          chapterNumber: 1,
          verseNumber: 4,
          pericopeNumber: '3',
          pericopeTitle: null,
        },
      ];
      vi.mocked(repo.getPericopeVersesForChapter).mockResolvedValue(mockVerses as any);

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          pericopeNumber: '1',
          pericopeTitle: 'The Word Became Flesh',
          verses: [
            { chapterNumber: 1, verseNumber: 1 },
            { chapterNumber: 1, verseNumber: 2 },
          ],
        },
        {
          pericopeNumber: '2',
          pericopeTitle: 'John the Baptist Denies Being the Messiah',
          verses: [{ chapterNumber: 1, verseNumber: 3 }],
        },
        {
          pericopeNumber: '3',
          pericopeTitle: null,
          verses: [{ chapterNumber: 1, verseNumber: 4 }],
        },
      ]);
    });

    it('returns 500 when repository throws on getChapterPericopes', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
      vi.mocked(repo.getPericopeSetIdForProject).mockRejectedValue(new Error('Database error'));

      const res = await server.request('/projects/10/pericopes/JHN/1', { method: 'GET' });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'An unexpected error occurred' });
    });
  });
});
