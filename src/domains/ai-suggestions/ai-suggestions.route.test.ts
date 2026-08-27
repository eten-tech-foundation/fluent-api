import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';

import * as aiSuggestionsService from './ai-suggestions.service';
import './ai-suggestions.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
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

// Removed permissions.service mock

vi.mock('./ai-suggestions.service', () => ({
  getAiSuggestions: vi.fn(),
  queueNextVerses: vi.fn(),
  trackUsage: vi.fn(),
}));

vi.mock('./ai-suggestions.auth.middleware', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-suggestions.auth.middleware')>();
  return {
    ...actual,
    checkProjectUnitAccess: vi.fn(),
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

function asAuthenticatedUser(granted = true) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: APP_USER });
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: granted ? [{ orgId: 1, projectId: 1, permissions: new Set(['project:view']) }] : [],
  });
}

function getAiSuggestions(projectUnitId: number, bibleTextIds: number[]) {
  const query = new URLSearchParams({ projectUnitId: projectUnitId.toString() });
  bibleTextIds.forEach((id) => query.append('bibleTextIds', id.toString()));
  return server.request(`/ai-suggestions?${query.toString()}`, {
    method: 'GET',
  });
}

function postQueueNext(body: unknown) {
  return server.request('/ai-suggestions/queue-next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postUsage(body: unknown) {
  return server.request('/ai-suggestions/usage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('ai-suggestions routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('get /ai-suggestions', () => {
    it('returns 401 when the caller is not authenticated', async () => {
      (auth.api.getSession as any).mockResolvedValue(null);
      const res = await getAiSuggestions(1, [10]);
      expect(res.status).toBe(401);
    });

    it('returns 200 with suggestions on success', async () => {
      asAuthenticatedUser(true);
      (aiSuggestionsService.getAiSuggestions as any).mockResolvedValue({
        ok: true,
        data: { data: [{ bibleTextId: 1, suggestedText: 'hello' }] },
      });

      const res = await getAiSuggestions(1, [10]);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      expect(json.data[0].suggestedText).toBe('hello');
    });
  });

  describe('post /ai-suggestions/queue-next', () => {
    const VALID_BODY = {
      projectUnitId: 1,
      bibleId: 2,
      bookCode: 'GEN',
      chapterNumber: 1,
      currentVerse: 1,
    };

    it('returns 403 when access check fails', async () => {
      asAuthenticatedUser(false);

      const res = await postQueueNext(VALID_BODY);
      expect(res.status).toBe(403);
      expect(aiSuggestionsService.queueNextVerses).not.toHaveBeenCalled();
    });

    it('returns 200 on success', async () => {
      asAuthenticatedUser(true);
      (aiSuggestionsService.queueNextVerses as any).mockResolvedValue({
        ok: true,
        data: { queueCount: 5, thresholdReached: true },
      });

      const res = await postQueueNext(VALID_BODY);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.queueCount).toBe(5);
      expect(json.thresholdReached).toBe(true);
    });
  });

  describe('post /ai-suggestions/usage', () => {
    const VALID_BODY = {
      bibleTextId: 10,
      projectUnitId: 1,
      wasUsed: true,
    };

    it('returns 403 when access check fails', async () => {
      asAuthenticatedUser(false);

      const res = await postUsage(VALID_BODY);
      expect(res.status).toBe(403);
      expect(aiSuggestionsService.trackUsage).not.toHaveBeenCalled();
    });

    it('returns 200 on success', async () => {
      asAuthenticatedUser(true);
      (aiSuggestionsService.trackUsage as any).mockResolvedValue({
        ok: true,
        data: undefined,
      });

      const res = await postUsage(VALID_BODY);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.message).toBe('Logged');
    });
  });
});
