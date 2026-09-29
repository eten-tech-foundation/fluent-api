import { vi } from 'vitest';

import type { UserResponse } from '@/domains/users/users.types';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';

export function asAuthenticatedSetUser(overrides: Partial<UserResponse> = {}) {
  const user: UserResponse = {
    id: 1,
    email: 'translator@example.com',
    username: 'translator',
    firstName: null,
    lastName: null,
    createdBy: null,
    status: 'verified',
    createdAt: null,
    updatedAt: null,
    lastActiveOrgId: null,
    ...overrides,
  };
  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: 's1',
      userId: 'auth-user-1',
      token: 'test-session-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 1e9),
    },
    user: {
      id: 'auth-user-1',
      name: user.username,
      email: user.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
  vi.mocked(getUserByEmail).mockResolvedValue(ok(user));
  // Sets are a shared catalog: any active authenticated user can read them,
  // without project membership or project-specific permissions.
  vi.mocked(findGrantsByUserId).mockResolvedValue(ok([]));
}
