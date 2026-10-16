import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/lib/auth';
import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/translation-resources/translation-resources.route';

import {
  asAuthenticatedUser,
  asProjectMember,
  IMAGES_RANGE_PATH,
  imageSearchHit,
  NOTES_RANGE_PATH,
  QUESTIONS_RANGE_PATH,
  searchHit,
  textDetails,
} from './translation-resources.test-fixtures';

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

vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  searchResources: vi.fn(),
  searchAllResources: vi.fn(),
  getResource: vi.fn(),
}));

describe('translation-resources verse-range routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('gET notes range', () => {
    it('returns empty items when Aquifer has no notes in the range', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(NOTES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
      expect(aquiferClient.searchAllResources).toHaveBeenCalledTimes(1);
      expect(aquiferClient.searchAllResources).toHaveBeenCalledWith(
        expect.objectContaining({
          bookCode: 'MRK',
          startChapter: 1,
          endChapter: 1,
          startVerse: 1,
          endVerse: 8,
          languageCode: 'eng',
          resourceCollectionCode: 'UWTranslationNotes',
        })
      );
    });

    it('returns hydrated deduped notes across the verse range', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const hits = [
        { ...searchHit, id: 101, name: 'one', localizedName: 'One' },
        { ...searchHit, id: 101, name: 'one-dup', localizedName: 'One Dup' },
        { ...searchHit, id: 202, name: 'two', localizedName: 'Two' },
      ];
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok(hits));
      vi.mocked(aquiferClient.getResource).mockImplementation(async (id: number) =>
        ok({ ...textDetails, id, name: String(id), localizedName: String(id) })
      );

      const res = await server.request(NOTES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.map((item: { id: number }) => item.id)).toEqual([101, 202]);
      expect(aquiferClient.getResource).toHaveBeenCalledTimes(2);
      expect(aquiferClient.searchAllResources).toHaveBeenCalledTimes(1);
    });

    it('returns 502 with a generic message when Aquifer search fails', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(NOTES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    });

    it('returns 400 when endVerse is before startVerse', async () => {
      asAuthenticatedUser();
      asProjectMember();

      const res = await server.request(
        '/projects/10/translation-resources/notes/MRK/1?languageCode=eng&startVerse=8&endVerse=1',
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 400 when the verse span exceeds the cap', async () => {
      asAuthenticatedUser();
      asProjectMember();

      const res = await server.request(
        '/projects/10/translation-resources/notes/MRK/1?languageCode=eng&startVerse=1&endVerse=201',
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request(NOTES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(401);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });
  });

  describe('gET questions range', () => {
    it('returns empty items when none exist', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(QUESTIONS_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
      expect(aquiferClient.searchAllResources).toHaveBeenCalledWith(
        expect.objectContaining({
          startVerse: 1,
          endVerse: 8,
          resourceCollectionCode: 'UWTranslationQuestions',
        })
      );
    });

    it('returns 502 when details hydration fails for every hit', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([searchHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(QUESTIONS_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    });
  });

  describe('gET images range', () => {
    it('returns deduped image items for the verse range', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const hits = [imageSearchHit(55), imageSearchHit(55), imageSearchHit(66)];
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok(hits));
      vi.mocked(aquiferClient.getResource).mockImplementation(async (id: number) =>
        ok({
          id,
          name: 'map',
          localizedName: `Map ${id}`,
          content: { url: `https://cdn.example/${id}.jpg`, size: id },
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 55,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/55.jpg',
            size: 55,
          },
          {
            id: 66,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/66.jpg',
            size: 66,
          },
        ],
      });
      expect(aquiferClient.getResource).toHaveBeenCalledTimes(2);
      expect(aquiferClient.searchAllResources).toHaveBeenCalledTimes(1);
      expect(aquiferClient.searchAllResources).toHaveBeenCalledWith(
        expect.objectContaining({
          startVerse: 1,
          endVerse: 8,
          resourceType: 'Images',
        })
      );
    });

    it('returns empty items when Aquifer has no images in the range', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(ok([]));

      const res = await server.request(IMAGES_RANGE_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });
  });
});
