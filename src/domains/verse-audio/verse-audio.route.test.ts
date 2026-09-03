import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode } from '@/lib/types';
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
  getCurrentVersionToken: vi.fn(),
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

      const res = await server.request(
        '/verse-audio?projectUnitId=1&bibleId=9&bookId=1&chapterNumber=1',
        { method: 'GET' }
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toHaveLength(1);
      expect(json.hasConflict).toBe(false);
      expect(verseAudioService.listChapterRecordings).toHaveBeenCalledWith(1, 9, 1, 1);
    });

    it('requires bibleId so chapter conflicts cannot cross Bible boundaries', async () => {
      asAuthenticatedUser([PERMISSIONS.PROJECT_VIEW]);

      const res = await server.request('/verse-audio?projectUnitId=1&bookId=1&chapterNumber=1', {
        method: 'GET',
      });

      expect(res.status).toBe(400);
      expect(verseAudioService.listChapterRecordings).not.toHaveBeenCalled();
    });
  });

  describe('put /verse-audio/{projectUnitId}/{bibleTextId}', () => {
    // The form validator enforces the declared schema, while the handler reads
    // a separate parseBody result and repeats the guard as defence in depth.
    function upload(baseVersionToken?: string) {
      const form = new FormData();
      form.append('file', new File(['abcd'], 'take.m4a', { type: 'audio/mp4' }));
      if (baseVersionToken !== undefined) {
        form.append('baseVersionToken', baseVersionToken);
      }
      return server.request('/verse-audio/1/10', { method: 'PUT', body: form });
    }

    beforeEach(() => {
      asAuthenticatedUser([PERMISSIONS.CONTENT_UPDATE]);
      (verseAudioService.uploadRecording as any).mockResolvedValue({
        ok: true,
        data: { id: 1, projectUnitId: 1, bibleTextId: 10, versionToken: 2 },
      });
    });

    it.each([
      ['not a number', 'abc'],
      ['zero', '0'],
      ['negative', '-1'],
      ['fractional', '1.5'],
    ])('rejects a %s baseVersionToken rather than treating it as absent', async (_label, value) => {
      const res = await upload(value);

      expect(res.status).toBe(400);
      expect(verseAudioService.uploadRecording).not.toHaveBeenCalled();
    });

    it.each([
      ['omitted', undefined],
      ['empty', ''],
    ])('treats an %s baseVersionToken as a legacy client', async (_label, value) => {
      const res = await upload(value);

      expect(res.status).toBe(200);
      expect(verseAudioService.uploadRecording).toHaveBeenCalledWith(
        expect.objectContaining({ baseVersionToken: undefined })
      );
    });

    it('forwards a well-formed token', async () => {
      const res = await upload('3');

      expect(res.status).toBe(200);
      expect(verseAudioService.uploadRecording).toHaveBeenCalledWith(
        expect.objectContaining({ baseVersionToken: 3 })
      );
    });

    it('returns 409 with currentVersionToken when concurrent cleanup invalidates an upload reference', async () => {
      vi.mocked(verseAudioService.uploadRecording).mockResolvedValue(
        err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT)
      );
      vi.mocked(verseAudioService.getCurrentVersionToken).mockResolvedValue({
        ok: true,
        data: 5,
      });

      const res = await upload('3');

      expect(res.status).toBe(409);
      expect(verseAudioService.getCurrentVersionToken).toHaveBeenCalledWith(1, 10);
      expect(await res.json()).toEqual({
        message:
          'Verse audio changed concurrently; use currentVersionToken from this response as baseVersionToken and retry',
        currentVersionToken: 5,
      });
    });

    it('returns 409 without currentVersionToken when the recording no longer exists', async () => {
      vi.mocked(verseAudioService.uploadRecording).mockResolvedValue(
        err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT)
      );
      vi.mocked(verseAudioService.getCurrentVersionToken).mockResolvedValue(
        err(ErrorCode.VERSE_AUDIO_NOT_FOUND)
      );

      const res = await upload('3');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        message:
          'Verse audio changed concurrently; use currentVersionToken from this response as baseVersionToken and retry',
      });
    });
  });

  describe('post /verse-audio/{projectUnitId}/{bibleTextId}/resolve', () => {
    function resolve(takeId = 11) {
      return server.request('/verse-audio/1/10/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ takeId }),
      });
    }

    beforeEach(() => {
      asAuthenticatedUser([PERMISSIONS.CONTENT_UPDATE]);
    });

    it('returns the resolved recording', async () => {
      vi.mocked(verseAudioService.resolveConflict).mockResolvedValue({
        ok: true,
        data: { id: 1, activeTakeId: 11, conflictStatus: 'clean' } as any,
      });

      const res = await resolve();

      expect(res.status).toBe(200);
      expect(verseAudioService.resolveConflict).toHaveBeenCalledWith({
        projectUnitId: 1,
        bibleTextId: 10,
        takeId: 11,
      });
    });

    it.each([[ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND, 404]])(
      'maps %s to %i',
      async (code, status) => {
        vi.mocked(verseAudioService.resolveConflict).mockResolvedValue(err(code));

        const res = await resolve();

        expect(res.status).toBe(status);
      }
    );

    it('returns 409 with currentVersionToken on version conflict', async () => {
      vi.mocked(verseAudioService.resolveConflict).mockResolvedValue(
        err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT)
      );
      vi.mocked(verseAudioService.getCurrentVersionToken).mockResolvedValue({
        ok: true,
        data: 7,
      });

      const res = await resolve();

      expect(res.status).toBe(409);
      expect(verseAudioService.getCurrentVersionToken).toHaveBeenCalledWith(1, 10);
      expect(await res.json()).toEqual({
        message:
          'Verse audio changed concurrently; use currentVersionToken from this response as baseVersionToken and retry',
        currentVersionToken: 7,
      });
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
