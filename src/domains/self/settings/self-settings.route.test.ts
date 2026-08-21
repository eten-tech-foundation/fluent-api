import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';

import type { UserSettingsRow } from './self-settings.repository';

import '@/domains/self/settings/self-settings.route';

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
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
    returning: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
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

// In-memory repository so the service logic (full-replace, `.catch({})`
// normalization, toResponse, user isolation) is genuinely exercised. Tests can
// also seed `store` directly to simulate a malformed/legacy stored blob that
// never went through the write validator (see the read-path normalization test).
const store = new Map<number, UserSettingsRow>();

vi.mock('./self-settings.repository', () => ({
  findByUser: vi.fn(async (userId: number) => ({ ok: true, data: store.get(userId) ?? null })),
  upsert: vi.fn(async (input: { userId: number; settings: unknown }) => {
    const row: UserSettingsRow = {
      settings: input.settings as never,
      updatedAt: new Date('2026-06-18T00:00:00.000Z'),
    };
    store.set(input.userId, row);
    return { ok: true, data: row };
  }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER_A = {
  id: 1,
  email: 'a@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

const USER_B = {
  id: 2,
  email: 'b@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

/** Authenticate as the given app user (no permission gate on the self domain). */
function authenticateAs(user: typeof USER_A) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: user });
  (findGrantsByUserId as any).mockResolvedValue({ ok: true, data: [] });
}

function getSettings() {
  return server.request('/self/settings', { method: 'GET' });
}

function putSettings(body: unknown) {
  return server.request('/self/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('gET /self/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await getSettings();

    expect(res.status).toBe(401);
  });

  it('returns 403 when the user account is inactive', async () => {
    authenticateAs({ ...USER_A, status: 'inactive' as never });

    const res = await getSettings();

    expect(res.status).toBe(403);
  });

  it('returns 200 with settings: null for a user with no row yet (not 404)', async () => {
    authenticateAs(USER_A);

    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ settings: null, updatedAt: null });
  });

  it('returns the saved blob after a PUT', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { checkIgnoredWordPairs: { 'the the': 'suppress' } } });

    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toEqual({ checkIgnoredWordPairs: { 'the the': 'suppress' } });
    expect(json.updatedAt).toBe('2026-06-18T00:00:00.000Z');
  });

  it('scopes reads to the session user — a caller never sees another user row', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { checkIgnoredWordPairs: { 'the the': 'suppress' } } });

    authenticateAs(USER_B);
    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toBeNull();
  });

  it('normalizes a malformed/legacy stored blob to {} on read (.catch({}) tolerance)', async () => {
    // Seed the store directly to simulate a row that never went through the write
    // validator (e.g. written by an older app version or a manual edit). The whole
    // blob is the wrong shape, so the tolerant read schema must degrade it to `{}`
    // rather than leaking the unnormalized value through GET.
    store.set(USER_A.id, {
      settings: { legacyKey: 'whatever', checkIgnoredWordPairs: 'not-an-object' } as never,
      updatedAt: new Date('2026-06-18T00:00:00.000Z'),
    });
    authenticateAs(USER_A);

    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toEqual({});
  });

  it('preserves a genuine null settings row (does not coerce null to {})', async () => {
    // A nullable column with no settings yet must stay `null` — parsing `null`
    // through `.catch({})` would yield `{}` and break the "settings: null when no
    // row" contract, so the read path guards null before parsing.
    store.set(USER_A.id, {
      settings: null,
      updatedAt: new Date('2026-06-18T00:00:00.000Z'),
    });
    authenticateAs(USER_A);

    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toBeNull();
  });
});

describe('pUT /self/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await putSettings({ settings: {} });

    expect(res.status).toBe(401);
  });

  it('returns 403 when the user account is inactive', async () => {
    authenticateAs({ ...USER_A, status: 'inactive' as never });

    const res = await putSettings({ settings: {} });

    expect(res.status).toBe(403);
  });

  it('creates then full-replaces (keys omitted on the second PUT are gone)', async () => {
    authenticateAs(USER_A);

    const created = await putSettings({
      settings: { checkIgnoredWordPairs: { 'the the': 'suppress', 'and and': 'suppress' } },
    });
    expect(created.status).toBe(200);
    expect((await created.json()).settings).toEqual({
      checkIgnoredWordPairs: { 'the the': 'suppress', 'and and': 'suppress' },
    });

    const replaced = await putSettings({ settings: {} });
    expect(replaced.status).toBe(200);
    expect((await replaced.json()).settings).toEqual({});
  });

  it('returns 422 on schema violation (wrong rule value type)', async () => {
    authenticateAs(USER_A);

    const res = await putSettings({
      settings: { checkIgnoredWordPairs: { 'the the': 'not-a-valid-verdict' } },
    });

    // A well-formed request whose body fails schema validation is a 422
    // (VALIDATION_ERROR), not a 400.
    expect(res.status).toBe(422);
  });

  it('strips unknown top-level keys on write (persists as {} rather than rejecting)', async () => {
    authenticateAs(USER_A);

    const res = await putSettings({ settings: { someFutureKey: 123 } });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toEqual({});
  });
});
