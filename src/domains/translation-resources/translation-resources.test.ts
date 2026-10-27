import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { auth } from '@/lib/auth';
import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/translation-resources/translation-resources.route';

import {
  asAuthenticatedUser,
  asProjectMember,
  IMAGES_PATH,
  imageSearchHit,
  MOCK_PROJECT,
  NOTES_PATH,
  QUESTIONS_PATH,
  searchEnumeration,
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
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([]));

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it('returns hydrated notes on success', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([searchHit]));
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

    it('returns 502 with a generic message when Aquifer search fails', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    });

    it('returns remaining notes when one content id fails to hydrate', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const hits = [
        { ...searchHit, id: 1, name: 'one', localizedName: 'One' },
        { ...searchHit, id: 2, name: 'two', localizedName: 'Two' },
        { ...searchHit, id: 3, name: 'three', localizedName: 'Three' },
      ];
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration(hits));
      vi.mocked(aquiferClient.getResource).mockImplementation(async (id: number) => {
        if (id === 2) return err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
        return ok({ ...textDetails, id, name: String(id), localizedName: String(id) });
      });

      const res = await server.request(NOTES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.map((item: { id: number }) => item.id)).toEqual([1, 3]);
    });

    it('returns 400 for an unknown bookCode instead of calling Aquifer', async () => {
      asAuthenticatedUser();
      asProjectMember();

      const res = await server.request(
        '/projects/10/translation-resources/notes/XYZ/14/1?languageCode=eng',
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });

    it('returns 400 for an invalid languageCode', async () => {
      asAuthenticatedUser();
      asProjectMember();

      const res = await server.request(
        '/projects/10/translation-resources/notes/MRK/14/1?languageCode=not-a-language',
        { method: 'GET' }
      );

      expect(res.status).toBe(400);
      expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
    });
  });

  describe('gET questions', () => {
    it('returns empty items when none exist', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([]));

      const res = await server.request(QUESTIONS_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });

    it('returns 502 when details hydration fails', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([searchHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request(QUESTIONS_PATH, { method: 'GET' });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    });
  });

  describe('gET images', () => {
    it('returns image items with urls and omits fabricated thumbnailUrl', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = imageSearchHit(55);
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
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
            size: 1200,
          },
        ],
      });
    });

    it('discovers url from href when Aquifer omits url', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = imageSearchHit(58);
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        ok({
          id: 58,
          name: 'map',
          localizedName: 'Map',
          content: { href: 'https://cdn.example/href.jpg', size: 88 },
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 58,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/href.jpg',
            size: 88,
          },
        ],
      });
    });

    it('discovers url and size inside array-wrapped Aquifer content', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = imageSearchHit(56);
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        ok({
          id: 56,
          name: 'map',
          localizedName: 'Map',
          content: [{ url: 'https://cdn.example/wrapped.jpg', size: 44 }],
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 56,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/wrapped.jpg',
            size: 44,
          },
        ],
      });
    });

    it('does not mix url, size, or thumbnailUrl from unrelated nested assets', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = imageSearchHit(59);
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        ok({
          id: 59,
          name: 'map',
          localizedName: 'Map',
          content: {
            url: 'https://cdn.example/real.jpg',
            nested: {
              url: 'https://other.example/wrong.jpg',
              size: 1,
              thumbnailUrl: 'https://other.example/t.jpg',
            },
          },
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 59,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/real.jpg',
          },
        ],
      });
    });

    it('includes thumbnailUrl only when Aquifer provides one', async () => {
      asAuthenticatedUser();
      asProjectMember();
      const imageHit = imageSearchHit(57);
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([imageHit]));
      vi.mocked(aquiferClient.getResource).mockResolvedValue(
        ok({
          id: 57,
          name: 'map',
          localizedName: 'Map',
          content: {
            url: 'https://cdn.example/full.jpg',
            thumbnailUrl: 'https://cdn.example/thumb.jpg',
            size: 9,
          },
          grouping: { type: 'Images', name: 'Images', mediaType: 'Image' },
        })
      );

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        items: [
          {
            id: 57,
            title: 'Faith',
            localizedName: 'Faith',
            url: 'https://cdn.example/full.jpg',
            thumbnailUrl: 'https://cdn.example/thumb.jpg',
            size: 9,
          },
        ],
      });
    });

    it('returns empty items when Aquifer has no images', async () => {
      asAuthenticatedUser();
      asProjectMember();
      vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([]));

      const res = await server.request(IMAGES_PATH, { method: 'GET' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: [] });
    });
  });
});
