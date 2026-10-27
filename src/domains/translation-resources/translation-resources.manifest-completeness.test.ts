import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger';
import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/translation-resources/translation-resources.route';

import {
  asAuthenticatedUser,
  asProjectMember,
  MANIFEST_PATH,
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

describe('translation-resources manifest completeness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps every required resource when one chapter has more than 100 notes (#431)', async () => {
    asAuthenticatedUser();
    asProjectMember();
    const hits = Array.from({ length: 101 }, (_, index) => ({
      ...searchHit,
      id: index + 1,
    }));
    vi.mocked(aquiferClient.searchAllResources)
      .mockResolvedValueOnce(searchEnumeration(hits))
      .mockResolvedValue(searchEnumeration([]));
    vi.mocked(aquiferClient.getResource).mockImplementation(async (id) =>
      ok({ ...textDetails, id })
    );

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.items).toHaveLength(101);
    expect(body.items.map((item: { aquiferContentId: number }) => item.aquiferContentId)).toEqual(
      hits.map((hit) => hit.id)
    );
    expect(body.totalBytes).toBe(
      body.items.reduce((sum: number, item: { bytesTotal: number }) => sum + item.bytesTotal, 0)
    );
    expect(body.totalBytes).toBeGreaterThan(0);
    expect(aquiferClient.getResource).toHaveBeenCalledTimes(101);
  });

  it('sets truncated and warns when Aquifer search enumeration is incomplete (#431)', async () => {
    asAuthenticatedUser();
    asProjectMember();
    const hits = Array.from({ length: 50 }, (_, index) => ({
      ...searchHit,
      id: index + 1,
    }));
    vi.mocked(aquiferClient.searchAllResources)
      .mockResolvedValueOnce(searchEnumeration(hits, false))
      .mockResolvedValue(searchEnumeration([]));
    vi.mocked(aquiferClient.getResource).mockImplementation(async (id) =>
      ok({ ...textDetails, id })
    );

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(true);
    expect(body.items).toHaveLength(50);
    expect(logger.warn).toHaveBeenCalledWith({
      message: 'Aquifer prepare-offline search hit page ceiling; marking manifest truncated',
      context: expect.objectContaining({
        resourceCollectionCode: 'UWTranslationNotes',
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
        collectedCount: 50,
      }),
    });
  });

  it('returns 502 when one manifest resource fails to hydrate (#432)', async () => {
    asAuthenticatedUser();
    asProjectMember();
    const hits = Array.from({ length: 100 }, (_, index) => ({
      ...searchHit,
      id: index + 1,
    }));
    vi.mocked(aquiferClient.searchAllResources)
      .mockResolvedValueOnce(searchEnumeration(hits))
      .mockResolvedValue(searchEnumeration([]));
    vi.mocked(aquiferClient.getResource).mockImplementation(async (id) =>
      id === 100 ? err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE) : ok({ ...textDetails, id })
    );

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
    expect(aquiferClient.getResource).toHaveBeenCalledTimes(100);
  });
  it('returns empty manifest when Aquifer has no resources', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(searchEnumeration([]));

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projectId: 10,
      sourceLanguageCode: 'eng',
      items: [],
      totalBytes: 0,
      truncated: false,
    });
    // TN, TW, TQ, StudyNotes, Images
    expect(aquiferClient.searchAllResources).toHaveBeenCalledTimes(5);
  });

  it('returns hydrated manifest items without serializedContent by default', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(aquiferClient.searchAllResources)
      .mockResolvedValueOnce(searchEnumeration([searchHit]))
      .mockResolvedValue(searchEnumeration([]));
    vi.mocked(aquiferClient.getResource).mockResolvedValue(ok(textDetails));

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe(10);
    expect(body.truncated).toBe(false);
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
    expect(body.items[0].serializedContent).toBeUndefined();
  });

  it('includes serializedContent when includeContent=true', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(aquiferClient.searchAllResources)
      .mockResolvedValueOnce(searchEnumeration([searchHit]))
      .mockResolvedValue(searchEnumeration([]));
    vi.mocked(aquiferClient.getResource).mockResolvedValue(ok(textDetails));

    const res = await server.request(`${MANIFEST_PATH}&includeContent=true`, { method: 'GET' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.items[0].serializedContent).toBe('string');
    const parsedContent = JSON.parse(body.items[0].serializedContent);
    expect(parsedContent).toEqual(textDetails.content);
    expect(body.items[0].bytesTotal).toBe(
      new TextEncoder().encode(body.items[0].serializedContent).byteLength
    );
  });

  it('returns 502 when Aquifer fails mid-manifest', async () => {
    asAuthenticatedUser();
    asProjectMember();
    vi.mocked(aquiferClient.searchAllResources).mockResolvedValue(
      err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
    );

    const res = await server.request(MANIFEST_PATH, { method: 'GET' });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ message: 'Aquifer service is unavailable' });
  });

  it('returns 400 when endChapter is before startChapter', async () => {
    asAuthenticatedUser();
    asProjectMember();

    const res = await server.request(
      '/projects/10/translation-resources/manifest?languageCode=eng&bookCode=MRK&startChapter=150&endChapter=1',
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
  });

  it('returns 400 when the chapter span exceeds the cap', async () => {
    asAuthenticatedUser();
    asProjectMember();

    const res = await server.request(
      '/projects/10/translation-resources/manifest?languageCode=eng&bookCode=PSA&startChapter=1&endChapter=150',
      { method: 'GET' }
    );

    expect(res.status).toBe(400);
    expect(aquiferClient.searchAllResources).not.toHaveBeenCalled();
  });
});
