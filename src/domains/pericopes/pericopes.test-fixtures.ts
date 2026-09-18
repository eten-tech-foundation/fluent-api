import { vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { UserResponse } from '@/domains/users/users.types';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';

export const APP_USER: UserResponse = {
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
};

export const MOCK_PROJECT: ProjectWithLanguageNames = {
  id: 10,
  name: 'Test Project',
  organization: 1,
  sourceLanguageId: 1,
  targetLanguageId: 1,
  sourceLanguageName: 'English',
  targetLanguageName: 'English',
  sourceName: 'Test Bible',
  isActive: true,
  status: 'active',
  createdBy: null,
  createdAt: null,
  updatedAt: null,
  metadata: {},
  pericopeSetId: 1,
  lastActivityAt: null,
  lastChapterActivity: null,
  chapterStatusCounts: {},
  workflowConfig: [],
};

// Both route suites mock these auth boundaries; the integration suite keeps SQL real.
export function asAuthenticatedUser(overrides: Partial<UserResponse> = {}) {
  const user = { ...APP_USER, ...overrides };
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
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([{ orgId: null, projectId: null, permissions: new Set(['project:view']) }])
  );
}
