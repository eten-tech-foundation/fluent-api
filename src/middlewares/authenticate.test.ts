import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';

import { authenticate } from './authenticate';

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
    },
  },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// vi.mock factories are hoisted by Vitest — any variables they close over must
// also be hoisted using vi.hoisted(), otherwise "Cannot access before initialization".
const { mockDbSelect, mockDbUpdate } = vi.hoisted(() => ({
  mockDbSelect: vi.fn(),
  mockDbUpdate: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    select: mockDbSelect,
    update: mockDbUpdate,
  },
}));

vi.mock('@/db/schema', () => ({
  authSession: {
    token: 'token',
    id: 'id',
    expiresAt: 'expires_at',
    isMobile: 'is_mobile',
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSelectChain(rows: object[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  mockDbSelect.mockReturnValue(chain);
  return chain;
}

function buildUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  mockDbUpdate.mockReturnValue(chain);
  return chain;
}

const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1000;
const TWENTY_NINE_DAYS_MS = 29 * 24 * 60 * 60 * 1000;
const TWENTY_FIVE_HOURS_MS = 25 * 60 * 60 * 1000;

function makeMockSession(
  overrides: {
    updatedAtMsAgo?: number;
    expiresInMs?: number;
  } = {}
) {
  const updatedAt = new Date(Date.now() - (overrides.updatedAtMsAgo ?? TWENTY_FIVE_HOURS_MS));
  const expiresAt = new Date(Date.now() + (overrides.expiresInMs ?? THIRTY_ONE_DAYS_MS));
  return {
    user: { email: 'test@example.com' },
    session: {
      id: 'session-id-123',
      updatedAt,
      expiresAt,
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('authenticate middleware', () => {
  let mockContext: any;
  let next: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      req: {
        path: '/api/some-domain',
        raw: { headers: new Headers() },
        header: vi.fn().mockReturnValue(undefined),
      },
      set: vi.fn(),
    };
    next = vi.fn().mockResolvedValue(undefined);
  });

  // ── Passthrough cases ────────────────────────────────────────────────────

  it('should skip authentication for /api/auth routes', async () => {
    mockContext.req.path = '/api/auth/sign-in';
    await authenticate(mockContext, next);
    expect(next).toHaveBeenCalled();
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('should call next() silently if no session and no Bearer token', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    mockContext.req.header.mockReturnValue(undefined);

    await authenticate(mockContext, next);

    expect(next).toHaveBeenCalled();
    expect(mockContext.set).not.toHaveBeenCalled();
    // No DB lookup should happen without a Bearer token
    expect(mockDbSelect).not.toHaveBeenCalled();
  });

  // ── Granular Bearer token error cases ───────────────────────────────────

  it('bearer token present + token not in DB → 401 "Invalid or revoked session token"', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    mockContext.req.header.mockReturnValue('Bearer invalid-token-xyz');

    buildSelectChain([]); // empty result = token not in DB

    await expect(authenticate(mockContext, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or revoked session token',
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('bearer token present + token found but expired → 401 "Session token has expired"', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    mockContext.req.header.mockReturnValue('Bearer expired-token-xyz');

    // Token IS in the DB (getSession rejected it = BetterAuth considers it expired)
    buildSelectChain([{ expiresAt: new Date(Date.now() - 1000) }]);

    await expect(authenticate(mockContext, next)).rejects.toMatchObject({
      status: 401,
      message: 'Session token has expired',
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('bearer token present + token found and not expired but getSession returned null → 401 "Invalid or revoked session token"', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    mockContext.req.header.mockReturnValue('Bearer revoked-token-xyz');

    // Token is in DB and has future expiresAt, but getSession still failed (e.g. user deleted)
    buildSelectChain([{ expiresAt: new Date(Date.now() + 100000) }]);

    await expect(authenticate(mockContext, next)).rejects.toMatchObject({
      status: 401,
      message: 'Invalid or revoked session token',
    });

    expect(next).not.toHaveBeenCalled();
  });

  it('bearer token present + getSession() returns valid session → passes through, no 401', async () => {
    const mockSession = makeMockSession({ expiresInMs: THIRTY_ONE_DAYS_MS });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok({ id: 1, email: 'test@example.com' }));
    mockContext.req.header.mockReturnValue('Bearer valid-token-xyz');

    // DB check for rolling: non-mobile session
    buildSelectChain([{ isMobile: false, expiresAt: new Date(Date.now() + THIRTY_ONE_DAYS_MS) }]);

    await authenticate(mockContext, next);

    expect(next).toHaveBeenCalled();
    expect(mockContext.set).toHaveBeenCalledWith('session', mockSession);
  });

  // ── Mobile session rolling cases ─────────────────────────────────────────

  it('mobile session with < 30 days remaining → rolls expiry by 60 days', async () => {
    const mockSession = makeMockSession({
      updatedAtMsAgo: TWENTY_FIVE_HOURS_MS, // stale: older than 24h → will check DB
      expiresInMs: TWENTY_NINE_DAYS_MS, // < 30 days remaining → should roll
    });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok({ id: 1, email: 'test@example.com' }));
    mockContext.req.header.mockReturnValue(undefined);

    buildSelectChain([{ isMobile: true, expiresAt: new Date(Date.now() + TWENTY_NINE_DAYS_MS) }]);
    const updateChain = buildUpdateChain();

    await authenticate(mockContext, next);

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({
        expiresAt: expect.any(Date),
        updatedAt: expect.any(Date),
      })
    );
    expect(next).toHaveBeenCalled();
  });

  it('mobile session with > 30 days remaining → does NOT roll expiry', async () => {
    const mockSession = makeMockSession({
      updatedAtMsAgo: TWENTY_FIVE_HOURS_MS, // stale: will check DB
      expiresInMs: THIRTY_ONE_DAYS_MS, // > 30 days → no roll needed
    });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok({ id: 1, email: 'test@example.com' }));
    mockContext.req.header.mockReturnValue(undefined);

    buildSelectChain([{ isMobile: true, expiresAt: new Date(Date.now() + THIRTY_ONE_DAYS_MS) }]);

    await authenticate(mockContext, next);

    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('non-mobile session → no DB rolling check performed', async () => {
    const mockSession = makeMockSession({ updatedAtMsAgo: TWENTY_FIVE_HOURS_MS });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok({ id: 1, email: 'test@example.com' }));
    mockContext.req.header.mockReturnValue(undefined);

    buildSelectChain([{ isMobile: false, expiresAt: new Date(Date.now() + THIRTY_ONE_DAYS_MS) }]);

    await authenticate(mockContext, next);

    // DB is read for the check (updatedAt is stale), but no update
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('fresh mobile session (updatedAt < 24h ago) → skips DB check entirely', async () => {
    const mockSession = makeMockSession({
      updatedAtMsAgo: 30 * 60 * 1000, // 30 minutes ago = fresh
      expiresInMs: TWENTY_NINE_DAYS_MS,
    });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok({ id: 1, email: 'test@example.com' }));
    mockContext.req.header.mockReturnValue(undefined);

    await authenticate(mockContext, next);

    // updatedAt is fresh — no DB select or update should happen
    expect(mockDbSelect).not.toHaveBeenCalled();
    expect(mockDbUpdate).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  // ── User lookup cases ────────────────────────────────────────────────────

  it('should set user and session in context if valid session and user exist', async () => {
    const mockSession = makeMockSession({ updatedAtMsAgo: 30 * 60 * 1000 });
    const mockUser = { id: 1, email: 'test@example.com' };
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok(mockUser));
    mockContext.req.header.mockReturnValue(undefined);

    await authenticate(mockContext, next);

    expect(mockContext.set).toHaveBeenCalledWith('session', mockSession);
    expect(mockContext.set).toHaveBeenCalledWith('user', mockUser);
    expect(next).toHaveBeenCalled();
  });

  it('should set only session if application user is not found', async () => {
    const mockSession = makeMockSession({ updatedAtMsAgo: 30 * 60 * 1000 });
    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue({ ok: false, error: { message: 'Not found' } });
    mockContext.req.header.mockReturnValue(undefined);

    await authenticate(mockContext, next);

    expect(mockContext.set).toHaveBeenCalledWith('session', mockSession);
    expect(mockContext.set).not.toHaveBeenCalledWith('user', expect.anything());
    expect(next).toHaveBeenCalled();
  });
});
