import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';
import { roleHasPermission } from '@/lib/services/permissions/permissions.service';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/translation-resources/translation-resources.route';

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

vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  searchResources: vi.fn(),
  searchAllResources: vi.fn(),
  getResource: vi.fn(),
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

const NOTES_PATH = '/projects/10/translation-resources/notes/MRK/14/1?languageCode=eng';
const QUESTIONS_PATH = '/projects/10/translation-resources/questions/MRK/14/1?languageCode=eng';
const IMAGES_PATH = '/projects/10/translation-resources/images/MRK/14/1?languageCode=eng';
const MANIFEST_PATH =
  '/projects/10/translation-resources/manifest?languageCode=eng&bookCode=MRK&startChapter=14&endChapter=14';

function asAuthenticatedUser(overrides: Partial<typeof APP_USER> = {}, grantedPermission = true) {
  const user = { ...APP_USER, ...overrides };
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue(ok(user));
  (roleHasPermission as any).mockResolvedValue(grantedPermission);
}

function asProjectMember() {
  vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

const searchHit = {
  id: 101,
  name: 'faith',
  localizedName: 'Faith',
  mediaType: 'Text' as const,
  languageCode: 'eng',
  grouping: {
    type: 'Guide' as const,
    name: 'Translation Notes',
    collectionTitle: 'Translation Notes',
    collectionCode: 'UWTranslationNotes',
  },
};

const textDetails = {
  id: 101,
  referenceId: 101,
  name: 'faith',
  localizedName: 'Faith',
  content: [{ tiptap: { type: 'doc', content: [{ type: 'paragraph' }] } }],
  grouping: { type: 'Guide' as const, name: 'Guide', mediaType: 'Text' },
  language: { id: 1, code: 'eng', displayName: 'English', scriptDirection: 'LTR' },
};

describe('translation-resources routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth gates', () => {
    it('returns 401 when unauthenticated (notes)', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(401);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 403 when user lacks PROJECT_VIEW', async () => {
      asAuthenticatedUser({}, false);

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(403);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 404 when project is inaccessible', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT as any));
      vi.mocked(resolveIsProjectMember).mockResolvedValue(false);

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(404);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 404 when project is missing', async () => {
      asAuthenticatedUser();
      vi.mocked(getProjectById).mockResolvedValue(err(ErrorCode.PROJECT_NOT_FOUND));

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(404);
    });
  });

  describe('gET notes', () => {
    it('returns empty items when Aquifer has no notes', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it('returns hydrated notes on success', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([searchHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(ok(textDetails));

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 101,
            name: 'faith',
            localizedName: 'Faith',
            content: textDetails.content,
          },
        ],
      });
    });

    it('returns 502 when Aquifer search fails', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    });
  });

  describe('gET questions', () => {
    it('returns empty items when none exist', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(QUESTIONS_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it('returns 502 when details hydration fails', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([searchHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(QUESTIONS_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
    });
  });

  describe('gET images', () => {
    it('returns image items with urls', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = {
        ...searchHit,
        id: 55,
        mediaType: 'Image' as const,
        grouping: {
          type: 'Images' as const,
          name: 'Images',
          collectionTitle: 'Images',
          collectionCode: 'Images',
        },
      };
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([imageHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        ok({
          id: 55,
          name: 'map',
          localizedName: 'Map of Judea',
          content: { url: 'https://cdn.example/map.jpg', size: 1200 },
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 55,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/map.jpg',
            thumbnailUrl: 'https://cdn.example/map.jpg',
            size: 1200,
          },
        ],
      });
    });

    it('returns empty items when Aquifer has no images', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });
  });

  describe('gET manifest', () => {
    it('returns empty manifest when Aquifer has no resources', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(MANIFEST_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        projectId: 10,
        sourceLanguageCode: 'eng',
        items: [],
        totalBytes: 0,
      });
      // TN, TW, TQ, StudyNotes, Images
      expect(aquiferClient.searchAllResources).toHaveBeenCalledTimes(5);
    });

    it('returns hydrated manifest items with sizes', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources)
        .mockResolvedValueOnce(ok([searchHit]))
        .mockResolvedValue(ok([]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(ok(textDetails));

      const res = await server.request(MANIFEST_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.projectId).toBe(10);
      expect(body.items).toHaveLength(1);
      expect(body.items[0]).toMatchObject({
        id: 'aquifer-101-text',
        tier: 2,
        kind: 'text',
        resourceName: 'Translation Notes',
        aquiferContentId: 101,
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
        collectionCode: 'UWTranslationNotes',
        fileExt: 'json',
      });
      expect(body.items[0].bytesTotal).toBeGreaterThan(0);
      expect(body.totalBytes).toBe(body.items[0].bytesTotal);
      expect(typeof body.items[0].serializedContent).toBe('string');
    });

    it('returns 502 when Aquifer fails mid-manifest', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(MANIFEST_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
    });
  });
});
