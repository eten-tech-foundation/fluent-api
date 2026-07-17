import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as usersService from '@/domains/users/users.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './project-users.repository';
import { addProjectUsers } from './project-users.service';

vi.mock('./project-users.repository', () => ({
  getProjectUsers: vi.fn(),
  addProjectUsers: vi.fn(),
  removeProjectUser: vi.fn(),
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('@/domains/users/users.service', () => ({
  getUsersByIds: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

describe('project-users service', () => {
  describe('addProjectUsers', () => {
    const projectId = 1;
    const roleId = 3;
    const userIds = [10, 20];
    const mockUsers = [
      { id: 10, username: 'alice' },
      { id: 20, username: 'bob' },
    ];

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('returns USER_NOT_FOUND if any userId does not exist', async () => {
      vi.mocked(usersService.getUsersByIds).mockResolvedValue(
        ok([{ id: 10, username: 'alice' }] as any)
      );

      const result = await addProjectUsers(projectId, [10, 99], roleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.USER_NOT_FOUND);
      expect(repo.addProjectUsers).not.toHaveBeenCalled();
    });

    it('returns INTERNAL_ERROR if user lookup fails', async () => {
      vi.mocked(usersService.getUsersByIds).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

      const result = await addProjectUsers(projectId, userIds, roleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(repo.addProjectUsers).not.toHaveBeenCalled();
    });

    it('propagates repo errors (e.g. invalid roleId → NOT_FOUND)', async () => {
      vi.mocked(usersService.getUsersByIds).mockResolvedValue(ok(mockUsers as any));
      vi.mocked(repo.addProjectUsers).mockResolvedValue(err(ErrorCode.NOT_FOUND));

      const result = await addProjectUsers(projectId, userIds, roleId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('passes roleId through to the repository', async () => {
      vi.mocked(usersService.getUsersByIds).mockResolvedValue(ok(mockUsers as any));
      vi.mocked(repo.addProjectUsers).mockResolvedValue(
        ok([
          { projectId, userId: 10, roleId, createdAt: null },
          { projectId, userId: 20, roleId, createdAt: null },
        ])
      );

      await addProjectUsers(projectId, userIds, roleId);

      expect(repo.addProjectUsers).toHaveBeenCalledWith(projectId, userIds, roleId);
    });

    it('returns enriched user records with displayName and roleID on success', async () => {
      vi.mocked(usersService.getUsersByIds).mockResolvedValue(ok(mockUsers as any));
      vi.mocked(repo.addProjectUsers).mockResolvedValue(
        ok([
          { projectId, userId: 10, roleId, createdAt: null },
          { projectId, userId: 20, roleId, createdAt: null },
        ])
      );

      const result = await addProjectUsers(projectId, userIds, roleId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([
          { projectId, userId: 10, roleId, createdAt: null, displayName: 'alice', roleID: roleId },
          { projectId, userId: 20, roleId, createdAt: null, displayName: 'bob', roleID: roleId },
        ]);
      }
    });
  });
});
