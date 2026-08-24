import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { server } from '@/server/server';

import * as verseAudioService from './verse-audio.service';
import './verse-audio.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/lib/audio-storage', () => ({
  isAudioStorageAvailable: vi.fn(() => true),
}));

vi.mock('@/db', () => {
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ organizationId: 1, projectId: 1 }]),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
      selectDistinct: vi.fn(() => mockQueryBuilder),
      insert: vi.fn(() => mockQueryBuilder),
      update: vi.fn(() => mockQueryBuilder),
      delete: vi.fn(() => mockQueryBuilder),
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

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectIdByUnitId: vi.fn().mockResolvedValue({ ok: true, data: { projectId: 1 } }),
  getProjectById: vi.fn().mockResolvedValue({
    ok: true,
    data: { id: 1, name: 'Test Project', organization: 1 },
  }),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn().mockResolvedValue(true),
}));

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  getAssignmentForVerse: vi.fn().mockResolvedValue({
    ok: true,
    data: {
      organizationId: 1,
      projectId: 1,
      assignedUserId: 1,
      peerCheckerId: null,
      status: 'draft',
    },
  }),
}));

vi.mock('./verse-audio.service', () => ({
  uploadRecording: vi.fn(),
  getRecording: vi.fn(),
  listChapterRecordings: vi.fn(),
  resolveConflict: vi.fn(),
  deleteRecording: vi.fn(),
}));

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  status: 'verified' as const,
};

function asAuthenticatedUser(
  permissions: string[] = [PERMISSIONS.PROJECT_VIEW, PERMISSIONS.CONTENT_UPDATE]
) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: APP_USER });
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: [{ orgId: 1, projectId: 1, permissions: new Set(permissions) }],
  });
}

describe('verse-audio routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isAudioStorageAvailable).mockReturnValue(true);
  });

  describe('get /verse-audio/{projectUnitId}/{bibleTextId}', () => {
    it('returns 401 when caller is unauthenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);
      const res = await server.request('/verse-audio/1/10', { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('returns 404 when caller lacks access to the target project', async () => {
      asAuthenticatedUser([PERMISSIONS.PROJECT_VIEW]);
      (findGrantsByUserId as any).mockResolvedValue({
        ok: true,
        data: [{ orgId: 1, projectId: 999, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) }],
      });
      const resolveIsProjectMember = (
        await import('@/domains/projects/users/project-users.service')
      ).resolveIsProjectMember;
      vi.mocked(resolveIsProjectMember).mockResolvedValueOnce(false);

      const res = await server.request('/verse-audio/1/10', { method: 'GET' });
      expect(res.status).toBe(404);
      expect(verseAudioService.getRecording).not.toHaveBeenCalled();
    });

    it('returns 200 with recording metadata on success', async () => {
      asAuthenticatedUser([PERMISSIONS.PROJECT_VIEW]);
      (verseAudioService.getRecording as any).mockResolvedValue({
        ok: true,
        data: { id: 1, projectUnitId: 1, bibleTextId: 10, downloadUrl: 'http://example.com/a.mp3' },
      });

      const res = await server.request('/verse-audio/1/10', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.downloadUrl).toBe('http://example.com/a.mp3');
    });
  });

  describe('get /verse-audio (chapter list)', () => {
    it('returns 200 with chapter items and hasConflict rollup', async () => {
      asAuthenticatedUser([PERMISSIONS.PROJECT_VIEW]);
      (verseAudioService.listChapterRecordings as any).mockResolvedValue({
        ok: true,
        data: {
          items: [{ id: 1, verseNumber: 1, downloadUrl: 'http://example.com/v1.mp3' }],
          hasConflict: false,
        },
      });

      const res = await server.request('/verse-audio?projectUnitId=1&bookId=1&chapterNumber=1', {
        method: 'GET',
      });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toHaveLength(1);
      expect(json.hasConflict).toBe(false);
    });
  });

  describe('delete /verse-audio/{projectUnitId}/{bibleTextId}', () => {
    it('returns 200 when recording deleted successfully', async () => {
      asAuthenticatedUser([PERMISSIONS.CONTENT_UPDATE]);
      (verseAudioService.deleteRecording as any).mockResolvedValue({
        ok: true,
        data: undefined,
      });

      const res = await server.request('/verse-audio/1/10', { method: 'DELETE' });
      expect(res.status).toBe(200);
    });
  });
});
