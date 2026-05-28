import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/lib/auth';

import { server } from './server';

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    // auth.api.getSession is used by the authenticate middleware — keep it available.
    api: {
      getSession: vi.fn(),
    },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

describe('server Route Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── POST /api/auth/forget-password ──────────────────────────────────────

  describe('pOST /api/auth/forget-password', () => {
    it('should proxy to auth.handler with path rewritten to /api/auth/request-password-reset', async () => {
      const mockResult = { success: true };
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify(mockResult), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await server.request('/api/auth/forget-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-type': 'mobile',
        },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(200);
      expect(auth.handler).toHaveBeenCalledOnce();

      // Verify the request was rewritten to the BetterAuth-native path so
      // rate limiting and other middleware in auth.handler are applied.
      const proxiedRequest: Request = (auth.handler as any).mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/api/auth/request-password-reset');

      // Original headers (including custom ones) must be forwarded.
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

  // ─── POST /api/auth/password/set ─────────────────────────────────────────

  describe('pOST /api/auth/password/set', () => {
    it('should proxy to auth.handler with path rewritten to /api/auth/set-password', async () => {
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify({ status: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const res = await server.request('/api/auth/password/set', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-token',
        },
        body: JSON.stringify({ newPassword: 'hunter2' }),
      });

      expect(res.status).toBe(200);
      expect(auth.handler).toHaveBeenCalledOnce();

      const proxiedRequest: Request = (auth.handler as any).mock.calls[0][0];
      expect(new URL(proxiedRequest.url).pathname).toBe('/api/auth/set-password');
      expect(proxiedRequest.headers.get('Authorization')).toBe('Bearer test-token');
    });
  });

  // ─── POST /api/auth/sign-out ──────────────────────────────────────────────

  describe('pOST /api/auth/sign-out', () => {
    it('should delegate to auth.handler so Set-Cookie headers are forwarded to the client', async () => {
      (auth.handler as any).mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 })
      );

      const res = await server.request('/api/auth/sign-out', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-123',
        },
      });

      expect(res.status).toBe(200);
      // auth.handler must be called (not auth.api.signOut) so BetterAuth can
      // return the full response including the Set-Cookie header for web clients.
      expect(auth.handler).toHaveBeenCalled();
    });
  });
});
