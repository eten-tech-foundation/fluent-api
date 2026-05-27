import { beforeEach, describe, expect, it, vi } from 'vitest';

import { auth } from '@/lib/auth';

import { server } from './server';

// ─── Module Mocks ────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: {
      requestPasswordReset: vi.fn(),
      signOut: vi.fn(),
      getSession: vi.fn(),
      setPassword: vi.fn(),
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

  describe('pOST /api/auth/forget-password', () => {
    it('should call auth.api.requestPasswordReset with body and headers', async () => {
      const mockResult = { success: true };
      (auth.api.requestPasswordReset as any).mockResolvedValue(mockResult);

      const requestBody = { email: 'test@example.com' };
      const res = await server.request('/api/auth/forget-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-client-type': 'mobile',
        },
        body: JSON.stringify(requestBody),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual(mockResult);

      expect(auth.api.requestPasswordReset).toHaveBeenCalledWith({
        body: requestBody,
        headers: expect.any(Headers),
      });

      const passedHeaders = (auth.api.requestPasswordReset as any).mock.calls[0][0].headers;
      expect(passedHeaders.get('x-client-type')).toBe('mobile');
    });

    it('should return 400 if auth.api.requestPasswordReset throws', async () => {
      (auth.api.requestPasswordReset as any).mockRejectedValue(new Error('BetterAuth Error'));

      const res = await server.request('/api/auth/forget-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json).toEqual({ message: 'Failed to send password reset email' });
    });
  });

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
      expect(auth.api.signOut).not.toHaveBeenCalled();
    });
  });
});
