import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import * as usersService from '@/domains/users/users.service';
import { ErrorCode } from '@/lib/types';

import * as repo from './org-users.repository';
import { updateOrgUserRole } from './org-users.service';

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findUserIdsInOrg: vi.fn(),
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserById: vi.fn(),
}));

vi.mock('./org-users.repository', () => ({
  updateOrgUserRole: vi.fn(),
  removeOrgUser: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const ORG = 10;
const CALLER = 1;
const TARGET = 2;
const ROLE_ID = 7;

const updatedUser = {
  id: TARGET,
  username: 'target',
  firstName: 'Target',
  lastName: 'User',
  email: 'target@example.com',
  status: 'verified' as const,
  createdAt: new Date('2026-09-16T12:00:00.000Z'),
  updatedAt: new Date('2026-09-16T12:00:00.000Z'),
  createdBy: null,
  grants: [],
};

describe('org-users service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('updateOrgUserRole', () => {
    it('rejects a caller changing their own org-level role (D2)', async () => {
      const result = await updateOrgUserRole(CALLER, ORG, CALLER, ROLE_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.FORBIDDEN);
      expect(repo.updateOrgUserRole).not.toHaveBeenCalled();
      expect(findUserIdsInOrg).not.toHaveBeenCalled();
    });

    it('rejects when the target user is not a member of the org', async () => {
      vi.mocked(findUserIdsInOrg).mockResolvedValue(new Set());

      const result = await updateOrgUserRole(CALLER, ORG, TARGET, ROLE_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_ORGANIZATION);
      expect(repo.updateOrgUserRole).not.toHaveBeenCalled();
    });

    it('delegates to the repository and returns the refreshed user', async () => {
      vi.mocked(findUserIdsInOrg).mockResolvedValue(new Set([TARGET]));
      vi.mocked(repo.updateOrgUserRole).mockResolvedValue({ ok: true, data: undefined });
      vi.mocked(usersService.getUserById).mockResolvedValue({ ok: true, data: updatedUser });

      const result = await updateOrgUserRole(CALLER, ORG, TARGET, ROLE_ID);

      expect(repo.updateOrgUserRole).toHaveBeenCalledWith(ORG, TARGET, ROLE_ID, CALLER);
      expect(usersService.getUserById).toHaveBeenCalledWith(TARGET);
      expect(result).toEqual({ ok: true, data: updatedUser });
    });

    it('propagates repository failures without fetching the user', async () => {
      vi.mocked(findUserIdsInOrg).mockResolvedValue(new Set([TARGET]));
      vi.mocked(repo.updateOrgUserRole).mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.INTERNAL_ERROR, message: 'boom' },
      });

      const result = await updateOrgUserRole(CALLER, ORG, TARGET, ROLE_ID);

      expect(result.ok).toBe(false);
      expect(usersService.getUserById).not.toHaveBeenCalled();
    });
  });
});
