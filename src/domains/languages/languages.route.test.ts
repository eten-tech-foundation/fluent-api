import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import * as languageService from './languages.service';
import './languages.route';

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

vi.mock('./languages.service', () => ({
  getAllLanguages: vi.fn(),
  getLanguageById: vi.fn(),
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

describe('get /languages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(auth.api.getSession as any).mockResolvedValue(null);

    const res = await server.request('/languages');

    expect(res.status).toBe(401);
    expect(languageService.getAllLanguages).not.toHaveBeenCalled();
  });

  it('returns all languages when updatedAfter is omitted', async () => {
    authenticate();
    const languages = [{ id: 1, langName: 'English', langCodeIso6393: 'eng' }];
    vi.mocked(languageService.getAllLanguages).mockResolvedValue(ok(languages as any));

    const res = await server.request('/languages');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(languages);
    expect(languageService.getAllLanguages).toHaveBeenCalledWith(undefined);
  });

  it('passes parsed updatedAfter Date to the service', async () => {
    authenticate();
    vi.mocked(languageService.getAllLanguages).mockResolvedValue(ok([]));

    const res = await server.request('/languages?updatedAfter=2025-01-01T00:00:00.000Z');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(languageService.getAllLanguages).toHaveBeenCalledWith(
      new Date('2025-01-01T00:00:00.000Z')
    );
  });

  it('returns 400 for a malformed updatedAfter timestamp', async () => {
    authenticate();

    const res = await server.request('/languages?updatedAfter=not-a-date');

    expect(res.status).toBe(400);
    expect(languageService.getAllLanguages).not.toHaveBeenCalled();
  });
});
