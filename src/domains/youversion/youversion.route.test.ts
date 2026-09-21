import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import * as youVersionClient from '@/lib/services/youversion/youversion.client';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/youversion/youversion.route';

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

vi.mock('@/lib/services/youversion/youversion.client', () => ({
  getBibles: vi.fn(),
  getChapterText: vi.fn(),
  isYouVersionConfigured: vi.fn(),
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

describe('youversion routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── Auth gates ─────────────────────────────────────────────────────────────

  describe('auth gates', () => {
    it('returns 401 when unauthenticated', async () => {
      vi.mocked(auth.api.getSession as any).mockResolvedValue(null);

      const res = await server.request('/youversion/bibles?languageTag=eng');

      expect(res.status).toBe(401);
      expect(youVersionClient.getBibles).not.toHaveBeenCalled();
    });

    it('returns 403 when user lacks CONTENT_VIEW permission', async () => {
      authenticateUserMock(false);

      const res = await server.request('/youversion/bibles?languageTag=eng');

      expect(res.status).toBe(403);
      expect(youVersionClient.getBibles).not.toHaveBeenCalled();
    });
  });

  // ─── GET /youversion/bibles ──────────────────────────────────────────────────

  describe('get /youversion/bibles', () => {
    it('returns bibles list and sets Cache-Control header', async () => {
      authenticateUserMock();
      const mockBibles = [
        {
          id: 1,
          abbreviation: 'NIV',
          localizedAbbreviation: 'NIV',
          title: 'New International Version',
          localizedTitle: 'New International Version',
          languageTag: 'eng',
        },
      ];
      vi.mocked(youVersionClient.getBibles).mockResolvedValue(ok(mockBibles));

      const res = await server.request('/youversion/bibles?languageTag=eng');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
      expect(youVersionClient.getBibles).toHaveBeenCalledWith('eng');
      const data = await res.json();
      expect(data).toEqual(mockBibles);
    });

    it('returns 400 when languageTag query param is missing', async () => {
      authenticateUserMock();

      const res = await server.request('/youversion/bibles');

      expect(res.status).toBe(400);
      expect(youVersionClient.getBibles).not.toHaveBeenCalled();
    });

    it('returns 502 Bad Gateway on YouVersion failure', async () => {
      authenticateUserMock();
      vi.mocked(youVersionClient.getBibles).mockResolvedValue(
        err(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE)
      );

      const res = await server.request('/youversion/bibles?languageTag=eng');

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data).toHaveProperty('message');
    });
  });

  // ─── GET /youversion/bibles/{bibleId}/chapters/{chapterId}/text ──────────────

  describe('get /youversion/bibles/{bibleId}/books/{bookId}/chapters/{chapterId}/text', () => {
    it('returns chapter text and sets Cache-Control header', async () => {
      authenticateUserMock();
      const mockChapterText = {
        bibleId: 1,
        bookId: 'GEN',
        chapterId: 1,
        verses: [
          { verseNumber: 1, passageId: 'GEN.1.1', content: 'In the beginning...' },
          { verseNumber: 2, passageId: 'GEN.1.2', content: 'Now the earth was...' },
        ],
      };
      vi.mocked(youVersionClient.getChapterText).mockResolvedValue(ok(mockChapterText));

      const res = await server.request('/youversion/bibles/1/books/GEN/chapters/1/text');

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, max-age=300');
      expect(youVersionClient.getChapterText).toHaveBeenCalledWith(1, 'GEN', 1);
      const data = await res.json();
      expect(data).toEqual(mockChapterText);
    });

    it('returns 404 when bookId path segment is absent', async () => {
      authenticateUserMock();

      const res = await server.request('/youversion/bibles/1/chapters/1/text');

      expect(res.status).toBe(404);
      expect(youVersionClient.getChapterText).not.toHaveBeenCalled();
    });

    it('returns 502 Bad Gateway on YouVersion failure', async () => {
      authenticateUserMock();
      vi.mocked(youVersionClient.getChapterText).mockResolvedValue(
        err(ErrorCode.YOUVERSION_SERVICE_UNAVAILABLE)
      );

      const res = await server.request('/youversion/bibles/1/books/GEN/chapters/1/text');

      expect(res.status).toBe(502);
      const data = await res.json();
      expect(data).toHaveProperty('message');
    });
  });
});
