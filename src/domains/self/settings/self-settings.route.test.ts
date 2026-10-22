import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result } from '@/lib/types';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { err, ErrorCode } from '@/lib/types';
import { server } from '@/server/server';

import type { UserSettingsRow } from './self-settings.repository';
import type { UserSettingsPatch } from './self-settings.types';

import '@/domains/self/settings/self-settings.route';

import { SETTINGS_CAPABILITIES } from './self-settings.types';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

// FA-L7 exception (pre-existing): authenticateUser / session wiring still touches
// `@/db` at import time. Repository is mocked for the settings leaf under test.
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

// In-memory repository with merge/delete semantics matching the SQL contract so
// service/route tests prove partial merge (fail under the old full-replace mock).
const { store, repoMocks } = vi.hoisted(() => {
  const store = new Map<number, UserSettingsRow>();

  function applyPatch(
    existing: Record<string, unknown> | null | undefined,
    patch: UserSettingsPatch
  ): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...(existing ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete merged[key];
      else merged[key] = value;
    }
    return merged;
  }

  return {
    store,
    repoMocks: {
      findByUser: vi.fn(async (userId: number) => ({
        ok: true as const,
        data: store.get(userId) ?? null,
      })),
      mergePatch: vi.fn(
        async (input: {
          userId: number;
          patch: UserSettingsPatch;
        }): Promise<Result<UserSettingsRow>> => {
          const prev = store.get(input.userId);
          const row: UserSettingsRow = {
            settings: applyPatch(
              prev?.settings as Record<string, unknown> | null,
              input.patch
            ) as never,
            updatedAt: new Date('2026-06-18T00:00:00.000Z'),
          };
          store.set(input.userId, row);
          return { ok: true, data: row };
        }
      ),
    },
  };
});

vi.mock('./self-settings.repository', () => repoMocks);

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

const CAPABILITIES = SETTINGS_CAPABILITIES;

/** Authenticate as the given app user (no permission gate on the self domain). */
function authenticateAs(user: typeof USER_A) {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  } as never);
  vi.mocked(getUserByEmail).mockResolvedValue({ ok: true, data: user } as never);
  vi.mocked(findGrantsByUserId).mockResolvedValue({ ok: true, data: [] } as never);
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

describe('GET /self/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

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
    expect(json).toEqual({
      settings: null,
      updatedAt: null,
      settingsCapabilities: CAPABILITIES,
    });
  });

  it('returns the saved blob after a PUT, with capability metadata', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { checkIgnoredWordPairs: { 'the the': 'suppress' } } });

    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toEqual({ checkIgnoredWordPairs: { 'the the': 'suppress' } });
    expect(json.updatedAt).toBe('2026-06-18T00:00:00.000Z');
    expect(json.settingsCapabilities).toEqual(CAPABILITIES);
  });

  it('scopes reads to the session user — a caller never sees another user row', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { checkIgnoredWordPairs: { 'the the': 'suppress' } } });

    authenticateAs(USER_B);
    const res = await getSettings();

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toBeNull();
    expect(json.settingsCapabilities).toEqual(CAPABILITIES);
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

describe('PUT /self/settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const res = await putSettings({ settings: {} });

    expect(res.status).toBe(401);
  });

  it('returns 403 when the user account is inactive', async () => {
    authenticateAs({ ...USER_A, status: 'inactive' as never });

    const res = await putSettings({ settings: {} });

    expect(res.status).toBe(403);
  });

  it('merges displayMode without erasing suppressions (legacy web-style write preserves displayMode)', async () => {
    authenticateAs(USER_A);

    const created = await putSettings({
      settings: {
        checkIgnoredWordPairs: { 'the the': 'suppress', 'and and': 'suppress' },
        displayMode: 'pericope',
      },
    });
    expect(created.status).toBe(200);
    expect((await created.json()).settings).toEqual({
      checkIgnoredWordPairs: { 'the the': 'suppress', 'and and': 'suppress' },
      displayMode: 'pericope',
    });

    // Old-client suppression-only PUT must not wipe displayMode (fails under full-replace).
    const suppressionOnly = await putSettings({
      settings: { checkIgnoredWordPairs: { 'the the': 'suppress' } },
    });
    expect(suppressionOnly.status).toBe(200);
    expect((await suppressionOnly.json()).settings).toEqual({
      checkIgnoredWordPairs: { 'the the': 'suppress' },
      displayMode: 'pericope',
    });

    // Mobile displayMode-only PUT preserves suppressions.
    const displayOnly = await putSettings({ settings: { displayMode: 'verse' } });
    expect(displayOnly.status).toBe(200);
    expect((await displayOnly.json()).settings).toEqual({
      checkIgnoredWordPairs: { 'the the': 'suppress' },
      displayMode: 'verse',
    });
  });

  it('treats empty settings as a no-op (does not erase existing keys)', async () => {
    authenticateAs(USER_A);
    await putSettings({
      settings: { displayMode: 'pericope', checkIgnoredWordPairs: { 'a a': 'suppress' } },
    });
    repoMocks.mergePatch.mockClear();

    const noop = await putSettings({ settings: {} });
    expect(noop.status).toBe(200);
    expect(repoMocks.mergePatch).not.toHaveBeenCalled();
    const json = await noop.json();
    expect(json.settings).toEqual({
      displayMode: 'pericope',
      checkIgnoredWordPairs: { 'a a': 'suppress' },
    });
    expect(json.settingsCapabilities).toEqual(CAPABILITIES);
  });

  it('deletes only displayMode when null; omits the key from the normalized response', async () => {
    authenticateAs(USER_A);
    await putSettings({
      settings: {
        displayMode: 'pericope',
        checkIgnoredWordPairs: { 'the the': 'surface' },
      },
    });

    const deleted = await putSettings({ settings: { displayMode: null } });
    expect(deleted.status).toBe(200);
    const json = await deleted.json();
    expect(json.settings).toEqual({ checkIgnoredWordPairs: { 'the the': 'surface' } });
    expect(json.settings).not.toHaveProperty('displayMode');
    expect(json.settingsCapabilities).toEqual(CAPABILITIES);
  });

  it('returns 422 when checkIgnoredWordPairs is null (does not erase suppressions)', async () => {
    authenticateAs(USER_A);
    await putSettings({
      settings: {
        displayMode: 'verse',
        checkIgnoredWordPairs: { 'the the': 'suppress' },
      },
    });

    const res = await putSettings({ settings: { checkIgnoredWordPairs: null } });
    expect(res.status).toBe(422);

    const get = await getSettings();
    expect(get.status).toBe(200);
    expect((await get.json()).settings).toEqual({
      displayMode: 'verse',
      checkIgnoredWordPairs: { 'the the': 'suppress' },
    });
  });

  it('clears checkIgnoredWordPairs to {} without erasing displayMode', async () => {
    authenticateAs(USER_A);
    await putSettings({
      settings: {
        displayMode: 'verse',
        checkIgnoredWordPairs: { 'the the': 'suppress' },
      },
    });

    const cleared = await putSettings({ settings: { checkIgnoredWordPairs: {} } });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).settings).toEqual({
      displayMode: 'verse',
      checkIgnoredWordPairs: {},
    });
  });

  it('returns 422 on invalid displayMode enum', async () => {
    authenticateAs(USER_A);

    const res = await putSettings({ settings: { displayMode: 'chapter' } });

    expect(res.status).toBe(422);
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

  it('strips unknown top-level keys (empty after strip is a no-op; no row stays null)', async () => {
    authenticateAs(USER_A);

    const res = await putSettings({ settings: { someFutureKey: 123 } });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.settings).toBeNull();
    expect(json.updatedAt).toBeNull();
    expect(json.settingsCapabilities).toEqual(CAPABILITIES);
  });

  it('isolates writes by account — user B cannot overwrite user A', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { displayMode: 'pericope' } });

    authenticateAs(USER_B);
    await putSettings({ settings: { displayMode: 'verse' } });

    authenticateAs(USER_A);
    const res = await getSettings();
    expect((await res.json()).settings).toEqual({ displayMode: 'pericope' });
  });

  it('same-key last server-saved write wins (no clock/ETag)', async () => {
    authenticateAs(USER_A);
    await putSettings({ settings: { displayMode: 'verse' } });
    const second = await putSettings({ settings: { displayMode: 'pericope' } });
    expect((await second.json()).settings).toEqual({ displayMode: 'pericope' });
  });

  it('surfaces repository failure as 500 (retryable from the client)', async () => {
    authenticateAs(USER_A);
    repoMocks.mergePatch.mockResolvedValueOnce(err(ErrorCode.INTERNAL_ERROR));

    const res = await putSettings({ settings: { displayMode: 'verse' } });

    expect(res.status).toBe(500);
  });
});
