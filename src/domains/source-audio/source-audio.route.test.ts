import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as sourceAudioRepo from './source-audio.repository';
import * as sourceAudioService from './source-audio.service';
import './source-audio.route';

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

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./source-audio.service', () => ({
  getChapterSourceAudio: vi.fn(),
  getSourceAudioManifest: vi.fn(),
}));

vi.mock('./source-audio.repository', () => ({
  isBibleBookLinkedToProject: vi.fn(),
}));

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

const CHAPTER_PATH = '/projects/10/source-audio/MRK/14?languageCode=eng&bibleId=1';
const MANIFEST_PATH =
  '/projects/10/source-audio/manifest?languageCode=eng&bibleId=1&bookCode=MRK&startChapter=14&endChapter=14';

const SAMPLE_RESPONSE = {
  provider: 'aquifer' as const,
  bible: {
    aquiferBibleId: 42,
    name: 'Berean Standard Bible',
    abbreviation: 'BSB',
    fluentBibleId: 1,
  },
  bookCode: 'MRK' as const,
  chapter: 14,
  items: [
    {
      format: 'mp3' as const,
      url: 'https://cdn.example/audio.mp3',
      sizeBytes: 12345,
      scope: 'chapter' as const,
    },
  ],
};

function asAuthenticatedUser(overrides: Partial<typeof APP_USER> = {}, grantedPermission = true) {
  const user = { ...APP_USER, ...overrides };
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(user));
  (findGrantsByUserId as any).mockResolvedValue(
    ok(
      grantedPermission
        ? [{ orgId: 999, projectId: 999, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) }]
        : []
    )
  );
}

function asProjectMember() {
  vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

describe('source-audio routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(ok(true));
  });

  describe('get /projects/{projectId}/source-audio/{bookCode}/{chapter}', () => {
    it('returns 401 when unauthenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);
      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('returns 404 when project is inaccessible', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(false);

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(404);
    });

    it('returns 200 with empty items for no audio', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioService.getChapterSourceAudio).mockResolvedValue(
        ok({ ...SAMPLE_RESPONSE, items: [] })
      );

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
    });

    it('returns 200 with playable URLs when audio exists', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioService.getChapterSourceAudio).mockResolvedValue(ok(SAMPLE_RESPONSE));

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].url).toBe('https://cdn.example/audio.mp3');
      expect(body.provider).toBe('aquifer');
    });

    it('returns 502 on Aquifer upstream failure', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioService.getChapterSourceAudio).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(502);
    });

    it('returns 404 when Fluent bible is not found', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioService.getChapterSourceAudio).mockResolvedValue(
        err(ErrorCode.BIBLE_NOT_FOUND)
      );

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });
      expect(res.status).toBe(404);
    });

    it('returns 404 without calling the service when the Bible is not linked to the project', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(ok(false));

      const res = await server.request(CHAPTER_PATH, { method: 'GET' });

      expect(res.status).toBe(404);
      expect(sourceAudioService.getChapterSourceAudio).not.toHaveBeenCalled();
    });
  });

  describe('get /projects/{projectId}/source-audio/manifest', () => {
    it.each([
      [
        'endChapter before startChapter',
        '/projects/10/source-audio/manifest?languageCode=eng&bibleId=1&bookCode=MRK&startChapter=14&endChapter=13',
      ],
      [
        'more than 20 chapters',
        '/projects/10/source-audio/manifest?languageCode=eng&bibleId=1&bookCode=MRK&startChapter=1&endChapter=21',
      ],
    ])('returns 400 for %s', async (_label, path) => {
      asAuthenticatedUser();
      asProjectMember();

      const res = await server.request(path, { method: 'GET' });

      expect(res.status).toBe(400);
      expect(sourceAudioService.getSourceAudioManifest).not.toHaveBeenCalled();
    });

    it('returns manifest items for chapter range', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioService.getSourceAudioManifest).mockResolvedValue(
        ok({
          projectId: 10,
          sourceLanguageCode: 'eng',
          provider: 'aquifer',
          totalBytes: 12345,
          items: [
            {
              id: 'source-audio-42-MRK-14-mp3',
              tier: 1,
              kind: 'audio',
              resourceName: 'Source Bible Audio',
              label: 'BSB MRK 14 (mp3)',
              required: true,
              removable: false,
              bytesTotal: 12345,
              sourceUrl: 'https://cdn.example/audio.mp3',
              fileExt: 'mp3',
              languageCode: 'eng',
              bookCode: 'MRK',
              startChapter: 14,
              endChapter: 14,
              format: 'mp3',
              aquiferBibleId: 42,
            },
          ],
        })
      );

      const res = await server.request(MANIFEST_PATH, { method: 'GET' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].tier).toBe(1);
    });

    it('returns 404 without calling the service when the Bible is not linked to the project', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(ok(false));

      const res = await server.request(MANIFEST_PATH, { method: 'GET' });

      expect(res.status).toBe(404);
      expect(sourceAudioService.getSourceAudioManifest).not.toHaveBeenCalled();
    });
  });
});
