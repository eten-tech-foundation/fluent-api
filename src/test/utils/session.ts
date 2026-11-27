import { vi } from 'vitest';

import { auth } from '@/lib/auth';

/**
 * Makes the mocked BetterAuth session lookup return a session for this person, so
 * `authenticate` loads the real app user and grants for that email from the test
 * database. The calling test file must `vi.mock('@/lib/auth')` with `api.getSession`.
 */
export function signInAs(person: { email: string; username: string }): void {
  const now = new Date();
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: {
      id: `session-${person.username}`,
      userId: `auth-${person.username}`,
      token: `token-${person.username}`,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    },
    user: {
      id: `auth-${person.username}`,
      name: person.username,
      email: person.email,
      emailVerified: true,
      banned: false,
      twoFactorEnabled: false,
      createdAt: now,
      updatedAt: now,
    },
  });
}
