import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';
import '@/routes/config.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────
// The route is login-gated (#211 Q1): the global passive `authenticate`
// middleware resolves the session → app user via BetterAuth + getUserByEmail and
// puts it on the context; `authenticateUser` on the route then 401s when there is
// no user. Mock those two boundaries so we can drive the authenticated /
// unauthenticated cases without a real DB or auth server (mirrors
// self-settings.route.test.ts).

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER = {
  id: 1,
  email: 'a@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

/** Drive the passive auth middleware to a valid session → linked app user. */
function authenticateAs(user: typeof USER) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: user });
}

function getFeatures() {
  return server.request('/config/features', { method: 'GET' });
}

describe('gET /config/features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the caller is not authenticated (no session)', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await getFeatures();

    expect(res.status).toBe(401);
  });

  it('returns 200 for an authenticated user', async () => {
    authenticateAs(USER);

    const res = await getFeatures();

    expect(res.status).toBe(200);
  });

  it('returns a named features map of booleans (authenticated)', async () => {
    authenticateAs(USER);

    const res = await getFeatures();
    const json = await res.json();

    expect(json).toHaveProperty('features');
    expect(typeof json.features).toBe('object');
    for (const value of Object.values(json.features)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('publishes the repeatedWordCheck flag (authenticated)', async () => {
    authenticateAs(USER);

    const res = await getFeatures();
    const json = await res.json();

    // .env.test wires FLUENT_AI_URL + FLUENT_AI_KEY and leaves the flag unset,
    // so the derived (safe) default resolves to true in the test env.
    expect(json.features).toHaveProperty('repeatedWordCheck');
    expect(json.features.repeatedWordCheck).toBe(true);
  });
});
