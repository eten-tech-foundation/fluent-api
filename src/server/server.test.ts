import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/lib/auth';

import { server } from './server';

// ─── Hoisted mocks (evaluated before vi.mock factories) ───────────────────────
// vi.mock() calls are hoisted to the top of the file by Vitest, so any
// variables they reference must also be hoisted via vi.hoisted().

const { mockDb, mockDbQueryBuilder } = vi.hoisted(() => {
  const mockDbQueryBuilder = (returnValue: unknown[]) => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(() => Promise.resolve(returnValue));
    builder.values = vi.fn(() => Promise.resolve());
    builder.set = vi.fn(() => builder);
    return builder;
  };

  const mockDb = {
    select: vi.fn(),
    delete: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  return { mockDb, mockDbQueryBuilder };
});

// ─── Module Mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn(),
      setPassword: vi.fn(),
    },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => ({ db: mockDb }));

vi.mock('@/db/schema', () => ({
  authSession: { token: 'token', id: 'id', userId: 'userId' },
  authAuditLog: {},
  users: { email: 'email' },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('server Route Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /api/auth/forget-password ────────────────────────────────────────

  describe('pOST /api/auth/forget-password', () => {
    it('should proxy to auth.handler with path rewritten to /api/auth/request-password-reset', async () => {
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await server.request('/api/auth/forget-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-client-type': 'mobile' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(200);
      expect(auth.handler).toHaveBeenCalledOnce();

      const proxiedRequest: Request = (auth.handler as any).mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/api/auth/request-password-reset');
      expect(proxiedRequest.headers.get('x-client-type')).toBe('mobile');
    });

    it('should propagate auth.handler error responses as-is', async () => {
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify({ message: 'Rate limit exceeded' }), { status: 429 })
      );

      const res = await server.request('/api/auth/forget-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(429);
    });
  });

  // ─── POST /api/auth/password/set ───────────────────────────────────────────

  describe('pOST /api/auth/password/set', () => {
    it('should call auth.api.setPassword, fetch session, and update user status to verified', async () => {
      (auth.api.setPassword as any).mockResolvedValue(undefined);
      (auth.api.getSession as any).mockResolvedValue({
        user: { email: 'test@example.com' },
      });

      const mockUpdateBuilder = mockDbQueryBuilder([]);
      mockDb.update.mockReturnValue(mockUpdateBuilder);

      const res = await server.request('/api/auth/password/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ newPassword: 'hunter2' }),
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      expect(auth.api.setPassword).toHaveBeenCalledWith({
        body: { newPassword: 'hunter2' },
        headers: expect.any(Headers),
      });
      expect(auth.api.getSession).toHaveBeenCalledWith({
        headers: expect.any(Headers),
      });
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockUpdateBuilder.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'verified' })
      );
    });

    it('should return 400 when JSON body is malformed', async () => {
      const res = await server.request('/api/auth/password/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: 'invalid-json-body',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toBeDefined();
    });

    it('should return 400 when auth.api.setPassword throws an error', async () => {
      (auth.api.setPassword as any).mockRejectedValue(new Error('Invalid password strength'));

      const res = await server.request('/api/auth/password/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
        body: JSON.stringify({ newPassword: '123' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.message).toBe('Invalid password strength');
    });
  });

  // ─── POST /api/auth/sign-out ────────────────────────────────────────────────

  describe('pOST /api/auth/sign-out', () => {
    it('bearer sign-out: deletes session from DB and returns { success: true } without calling auth.handler', async () => {
      const sessionRow = { id: 'sess-abc', userId: 'user-123' };
      mockDb.select.mockReturnValue(mockDbQueryBuilder([sessionRow]));
      mockDb.delete.mockReturnValue(mockDbQueryBuilder([]));
      mockDb.insert.mockReturnValue(mockDbQueryBuilder([]));

      const res = await server.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-token-123' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // Must NOT fall through to BetterAuth's cookie-based handler
      expect(auth.handler).not.toHaveBeenCalled();
      // DB lookup and delete must have been initiated
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('bearer sign-out: returns { success: true } even when token is not in DB (idempotent)', async () => {
      // Token not found — empty result set
      mockDb.select.mockReturnValue(mockDbQueryBuilder([]));

      const res = await server.request('/api/auth/sign-out', {
        method: 'POST',
        headers: { Authorization: 'Bearer already-expired-token' },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // No session found → delete must not have been called
      expect(mockDb.delete).not.toHaveBeenCalled();
      expect(auth.handler).not.toHaveBeenCalled();
    });

    it('cookie sign-out: delegates to auth.handler so Set-Cookie headers are forwarded to the client', async () => {
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Set-Cookie': 'session=; Max-Age=0; Path=/' },
        })
      );

      // No Authorization header → cookie-based path
      const res = await server.request('/api/auth/sign-out', { method: 'POST' });

      expect(res.status).toBe(200);
      // Must delegate to BetterAuth so it can clear the session cookie
      expect(auth.handler).toHaveBeenCalledOnce();
    });
  });
});
