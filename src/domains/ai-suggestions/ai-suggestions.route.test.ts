import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { roleHasPermission } from '@/lib/services/permissions/permissions.service';
import { server } from '@/server/server';

import { checkProjectUnitAccess } from './ai-suggestions.auth.middleware';
import * as aiSuggestionsService from './ai-suggestions.service';
import './ai-suggestions.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

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

vi.mock('./ai-suggestions.service', () => ({
  getAiSuggestions: vi.fn(),
  queueNextVerses: vi.fn(),
  trackUsage: vi.fn(),
}));

vi.mock('./ai-suggestions.auth.middleware', () => ({
  checkProjectUnitAccess: vi.fn(),
  requireProjectUnitAccess: vi.fn().mockImplementation(() => async (c: any, next: any) => next()),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

function asAuthenticatedUser(granted: boolean) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: APP_USER });
  (roleHasPermission as any).mockResolvedValue(granted);
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

describe('ai-suggestions routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (checkProjectUnitAccess as any).mockResolvedValue(null);
  });

  describe('GET /ai-suggestions', () => {
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

  describe('POST /ai-suggestions/queue-next', () => {
    const VALID_BODY = {
      projectUnitId: 1,
      bibleId: 2,
      bookCode: 'GEN',
      chapterNumber: 1,
      currentVerse: 1,
    };

    it('returns 403 when access check fails', async () => {
      asAuthenticatedUser(true);
      (checkProjectUnitAccess as any).mockResolvedValue(
        new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })
      );

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
});
