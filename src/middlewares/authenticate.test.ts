import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';

import { authenticate } from './authenticate';

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

describe('authenticate middleware', () => {
  let mockContext: any;
  let next: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockContext = {
      req: {
        path: '/api/some-domain',
        raw: {
          headers: new Headers(),
        },
      },
      set: vi.fn(),
    };
    next = vi.fn().mockResolvedValue(undefined);
  });

  it('should skip authentication for /api/auth routes', async () => {
    mockContext.req.path = '/api/auth/sign-in';
    await authenticate(mockContext, next);
    expect(next).toHaveBeenCalled();
    expect(auth.api.getSession).not.toHaveBeenCalled();
  });

  it('should call next() if no session is found', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    await authenticate(mockContext, next);
    expect(auth.api.getSession).toHaveBeenCalled();
    expect(mockContext.set).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('should set user and session in context if valid session and user exist', async () => {
    const mockSession = { user: { email: 'test@example.com' } };
    const mockUser = { id: 1, email: 'test@example.com' };

    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue(ok(mockUser));

    await authenticate(mockContext, next);

    expect(mockContext.set).toHaveBeenCalledWith('session', mockSession);
    expect(mockContext.set).toHaveBeenCalledWith('user', mockUser);
    expect(next).toHaveBeenCalled();
  });

  it('should set only session if user is not found in database', async () => {
    const mockSession = { user: { email: 'test@example.com' } };

    (auth.api.getSession as any).mockResolvedValue(mockSession);
    (getUserByEmail as any).mockResolvedValue({ ok: false, error: { message: 'Not found' } });

    await authenticate(mockContext, next);

    expect(mockContext.set).toHaveBeenCalledWith('session', mockSession);
    expect(mockContext.set).not.toHaveBeenCalledWith('user', expect.anything());
    expect(next).toHaveBeenCalled();
  });
});
