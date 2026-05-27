import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from './auth';

// ─── Module Mocks ────────────────────────────────────────────────────────────

// We mock the database and schema
const { mockDbUpdate } = vi.hoisted(() => ({
  mockDbUpdate: vi.fn(),
}));

vi.mock('@/db', () => ({
  db: {
    update: mockDbUpdate,
  },
}));

vi.mock('@/db/schema', () => ({
  authUser: { id: 'id', name: 'name', email: 'email' },
  authSession: {
    id: 'id',
    expiresAt: 'expires_at',
    isMobile: 'is_mobile',
    token: 'token',
  },
  authAccount: { id: 'id' },
  authVerification: { id: 'id' },
  authAuditLog: { id: 'id' },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('betterAuth configuration - hooks.after', () => {
  let mockUpdateChain: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateChain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    };
    mockDbUpdate.mockReturnValue(mockUpdateChain);
  });

  // Extract the hook from options — the first test guards it is defined before other tests run.
  const hook = auth.options?.hooks?.after as (ctx: any) => Promise<void>;

  it('should have the hook defined', () => {
    expect(hook).toBeDefined();
    expect(typeof hook).toBe('function');
  });

  it('should skip if path is not /sign-in/email', async () => {
    const ctx: any = {
      path: '/sign-up/email',
      context: {
        newSession: {
          session: { id: 'session-123' },
        },
      },
      headers: new Headers({ 'x-client-type': 'mobile' }),
    };

    await hook(ctx);

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('should skip if there is no newSession', async () => {
    const ctx: any = {
      path: '/sign-in/email',
      context: {},
      headers: new Headers({ 'x-client-type': 'mobile' }),
    };

    await hook(ctx);

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('should skip if request does not have mobile headers/UA', async () => {
    const ctx: any = {
      path: '/sign-in/email',
      context: {
        newSession: {
          session: { id: 'session-123' },
        },
      },
      headers: new Headers({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }),
    };

    await hook(ctx);

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('should skip if only x-client-type: mobile is sent (missing user-agent: fluent-mobile)', async () => {
    const ctx: any = {
      path: '/sign-in/email',
      context: {
        newSession: {
          session: { id: 'session-123' },
        },
      },
      // x-client-type alone is not sufficient — must also have user-agent: fluent-mobile
      headers: new Headers({ 'x-client-type': 'mobile' }),
    };

    await hook(ctx);

    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('should extend session to 60 days and set isMobile=true when both x-client-type: mobile AND user-agent: fluent-mobile are present', async () => {
    const ctx: any = {
      path: '/sign-in/email',
      context: {
        newSession: {
          session: { id: 'session-123' },
        },
      },
      headers: new Headers({ 'x-client-type': 'mobile', 'user-agent': 'fluent-mobile' }),
    };

    const beforeHookTime = Date.now();
    await hook(ctx);
    const afterHookTime = Date.now();

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockUpdateChain.set).toHaveBeenCalled();

    // Retrieve the update values passed to .set()
    const setArgs = mockUpdateChain.set.mock.calls[0][0];
    expect(setArgs.isMobile).toBe(true);
    expect(setArgs.expiresAt).toBeInstanceOf(Date);

    // Check that expiresAt is approximately 60 days in the future
    const expectedTime = beforeHookTime + 60 * 24 * 60 * 60 * 1000;
    const actualTime = setArgs.expiresAt.getTime();
    expect(actualTime).toBeGreaterThanOrEqual(expectedTime);
    expect(actualTime).toBeLessThanOrEqual(afterHookTime + 60 * 24 * 60 * 60 * 1000);
  });

  it('should extend session to 60 days and set isMobile=true when UA contains fluentmobile', async () => {
    const ctx: any = {
      path: '/sign-in/email',
      context: {
        newSession: {
          session: { id: 'session-123' },
        },
      },
      headers: new Headers({ 'user-agent': 'some-app-fluentmobile-client/1.0' }),
    };

    await hook(ctx);

    expect(mockDbUpdate).toHaveBeenCalled();
    const setArgs = mockUpdateChain.set.mock.calls[0][0];
    expect(setArgs.isMobile).toBe(true);
  });
});
