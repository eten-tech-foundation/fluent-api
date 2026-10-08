import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import * as bibleService from './bibles.service';
import './bibles.route';

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

vi.mock('./bibles.service', () => ({
  getAllBibles: vi.fn(),
  getBibleById: vi.fn(),
  getBiblesByLanguageId: vi.fn(),
  searchSourceBibles: vi.fn(),
  createBible: vi.fn(),
  updateBible: vi.fn(),
  deleteBible: vi.fn(),
}));

const MOCK_USER = {
  id: 1,
  email: 'test@example.com',
  status: 'verified' as const,
};

function authenticate() {
  vi.mocked(auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: MOCK_USER.email },
  });
  vi.mocked(getUserByEmail as any).mockResolvedValue(ok(MOCK_USER));
  vi.mocked(findGrantsByUserId as any).mockResolvedValue(ok([]));
}

describe('get /bibles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns all bibles when updatedAfter is omitted', async () => {
    authenticate();
    const bibles = [
      {
        id: 1,
        name: 'ESV',
        abbreviation: 'ESV',
        languageId: 1,
        hasAudio: false,
        provider: 'dbl',
      },
    ];
    vi.mocked(bibleService.getAllBibles).mockResolvedValue(ok(bibles as any));

    const res = await server.request('/bibles');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(bibles);
    expect(bibleService.getAllBibles).toHaveBeenCalledWith(undefined);
  });

  it('returns an empty array when nothing changed after updatedAfter', async () => {
    authenticate();
    vi.mocked(bibleService.getAllBibles).mockResolvedValue(ok([]));

    const res = await server.request('/bibles?updatedAfter=2025-01-15T12:00:00.000Z');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(bibleService.getAllBibles).toHaveBeenCalledWith(new Date('2025-01-15T12:00:00.000Z'));
  });

  it('returns 400 for a malformed updatedAfter timestamp', async () => {
    authenticate();

    const res = await server.request('/bibles?updatedAfter=@@@');

    expect(res.status).toBe(400);
    expect(bibleService.getAllBibles).not.toHaveBeenCalled();
  });
});
