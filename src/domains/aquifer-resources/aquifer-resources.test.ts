import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import * as aquiferClient from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/aquifer-resources/aquifer-resources.route';

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

vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getLanguages: vi.fn(),
  getAvailableResources: vi.fn(),
  getResourceCollection: vi.fn(),
  searchResources: vi.fn(),
  getResource: vi.fn(),
  getResourceAssociations: vi.fn(),
  getBibles: vi.fn(),
  getBibleText: vi.fn(),
}));

const MOCK_USER = {
  id: 1,
  email: 'test@example.com',
  role: 5,
  roleName: 'Translator',
  organization: 1,
  status: 'verified' as const,
};

function authenticateUserMock(hasPermission = true) {
  vi.mocked(auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: MOCK_USER.email },
  });
  vi.mocked(getUserByEmail as any).mockResolvedValue(ok(MOCK_USER));
  vi.mocked(findGrantsByUserId as any).mockResolvedValue(
    ok(
      hasPermission
        ? [{ orgId: 1, projectId: 1, permissions: new Set([PERMISSIONS.CONTENT_VIEW]) }]
        : []
    )
  );
}

describe('aquifer-resources routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('auth Gates', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request('/aquifer/languages');

      expect(res.status).toBe(401);
      expect(aquiferClient.getLanguages).not.toHaveBeenCalled();
    });

    it('returns 403 when user lacks CONTENT_VIEW permission', async () => {
      authenticateUserMock(false);

      const res = await server.request('/aquifer/languages');

      expect(res.status).toBe(403);
      expect(aquiferClient.getLanguages).not.toHaveBeenCalled();
    });
  });

  describe('gET /aquifer/languages', () => {
    it('returns languages and sets Cache-Control header', async () => {
      authenticateUserMock();
      const mockLanguages = [
        {
          id: 1,
          code: 'eng',
          englishDisplay: 'English',
          localizedDisplay: 'English',
          scriptDirection: 'LTR',
        },
      ];
      vi.mocked(aquiferClient.getLanguages).mockResolvedValue(ok(mockLanguages));

      const res = await server.request('/aquifer/languages');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
      const data = await res.json();
      expect(data).toEqual(mockLanguages);
    });

    it('returns 502 Bad Gateway on Aquifer failure', async () => {
      authenticateUserMock();
      vi.mocked(aquiferClient.getLanguages).mockResolvedValue(
        err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
      );

      const res = await server.request('/aquifer/languages');

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data).toHaveProperty('message');
    });
  });

  describe('gET /aquifer/languages/available-resources', () => {
    it('returns available resource counts for query params', async () => {
      authenticateUserMock();
      const mockCounts = [
        { languageId: 1, languageCode: 'eng', resourceCounts: [{ type: 'Guide', count: 10 }] },
      ];
      vi.mocked(aquiferClient.getAvailableResources).mockResolvedValue(ok(mockCounts));

      const res = await server.request(
        '/aquifer/languages/available-resources?bookCode=MRK&startChapter=1&endChapter=1'
      );

      expect(res.status).toBe(200);
      expect(aquiferClient.getAvailableResources).toHaveBeenCalledWith({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        startVerse: undefined,
        endVerse: undefined,
      });
      const data = await res.json();
      expect(data).toEqual(mockCounts);
    });
  });

  describe('gET /aquifer/resources/collections/{code}', () => {
    it('returns resource collection details with Cache-Control', async () => {
      authenticateUserMock();
      const mockCollection = {
        code: 'UWTranslationNotes',
        displayName: 'Translation Notes',
        availableLanguages: [
          { languageId: 1, languageCode: 'eng', displayName: 'English', resourceItemCount: 100 },
        ],
      };
      vi.mocked(aquiferClient.getResourceCollection).mockResolvedValue(ok(mockCollection));

      const res = await server.request('/aquifer/resources/collections/UWTranslationNotes');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
      expect(aquiferClient.getResourceCollection).toHaveBeenCalledWith('UWTranslationNotes');
      const data = await res.json();
      expect(data).toEqual(mockCollection);
    });
  });

  describe('gET /aquifer/resources/search', () => {
    it('returns search results', async () => {
      authenticateUserMock();
      const mockSearch = {
        totalItemCount: 1,
        returnedItemCount: 1,
        offset: 0,
        items: [
          {
            id: 101,
            name: 'faith',
            localizedName: 'Faith',
            mediaType: 'Text',
            languageCode: 'eng',
            grouping: { type: 'Guide', name: 'Guide' },
          },
        ],
      };
      vi.mocked(aquiferClient.searchResources).mockResolvedValue(ok(mockSearch));

      const res = await server.request(
        '/aquifer/resources/search?bookCode=MRK&startChapter=1&endChapter=1&languageCode=eng'
      );

      expect(res.status).toBe(200);
      expect(aquiferClient.searchResources).toHaveBeenCalledWith({
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        languageCode: 'eng',
        startVerse: undefined,
        endVerse: undefined,
        resourceType: undefined,
        resourceCollectionCode: undefined,
        limit: undefined,
        offset: undefined,
      });
      const data = await res.json();
      expect(data).toEqual(mockSearch);
    });
  });

  describe('gET /aquifer/resources/{contentId}', () => {
    it('returns resource details by contentId', async () => {
      authenticateUserMock();
      const mockDetails = {
        id: 101,
        name: 'faith',
        localizedName: 'Faith',
        content: { tiptap: 'content' },
        grouping: { type: 'Guide', name: 'Guide' },
      };
      vi.mocked(aquiferClient.getResource).mockResolvedValue(ok(mockDetails as any));

      const res = await server.request('/aquifer/resources/101');

      expect(res.status).toBe(200);
      expect(aquiferClient.getResource).toHaveBeenCalledWith(101);
      const data = await res.json();
      expect(data).toEqual(mockDetails);
    });
  });

  describe('gET /aquifer/resources/{parentResourceId}/associations', () => {
    it('returns resource associations', async () => {
      authenticateUserMock();
      const mockAssoc = {
        resourceAssociations: [{ referenceId: 101, contentId: 102 }],
      };
      vi.mocked(aquiferClient.getResourceAssociations).mockResolvedValue(ok(mockAssoc));

      const res = await server.request('/aquifer/resources/101/associations');

      expect(res.status).toBe(200);
      expect(aquiferClient.getResourceAssociations).toHaveBeenCalledWith(101);
      const data = await res.json();
      expect(data).toEqual(mockAssoc);
    });
  });

  describe('gET /aquifer/bibles', () => {
    it('returns bibles for language query', async () => {
      authenticateUserMock();
      const mockBibles = [{ id: 1, name: 'BSB', abbreviation: 'BSB' }];
      vi.mocked(aquiferClient.getBibles).mockResolvedValue(ok(mockBibles));

      const res = await server.request('/aquifer/bibles?languageCode=eng');

      expect(res.status).toBe(200);
      expect(aquiferClient.getBibles).toHaveBeenCalledWith('eng');
      const data = await res.json();
      expect(data).toEqual(mockBibles);
    });
  });

  describe('gET /aquifer/bibles/{bibleId}/texts', () => {
    it('returns bible texts', async () => {
      authenticateUserMock();
      const mockText = {
        bibleId: 1,
        bibleName: 'BSB',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [{ number: 1, verses: [{ number: 1, text: 'Beginning' }] }],
      };
      vi.mocked(aquiferClient.getBibleText).mockResolvedValue(ok(mockText));

      const res = await server.request(
        '/aquifer/bibles/1/texts?bookCode=MRK&startChapter=1&endChapter=1'
      );

      expect(res.status).toBe(200);
      expect(aquiferClient.getBibleText).toHaveBeenCalledWith({
        aquiferBibleId: 1,
        bookCode: 'MRK',
        startChapter: 1,
        endChapter: 1,
        includeAudio: undefined,
      });
      const data = await res.json();
      expect(data).toEqual(mockText);
    });
  });
});
