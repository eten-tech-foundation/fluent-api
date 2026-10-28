import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { projects, user_roles } from '@/db/schema';
import { ROLES } from '@/lib/roles';
import { ErrorCode } from '@/lib/types';

import * as repo from './project-users.repository';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  return {
    ...actual,
    eq: vi.fn((...args) => args),
    and: vi.fn((...args) => args),
    sql: vi.fn((...args) => args),
  };
});

vi.mock('@/domains/user-roles/user-roles.service', () => ({
  getRoleId: vi.fn(async (roleName: string) => {
    switch (roleName) {
      case ROLES.ORG_MANAGER:
        return 1;
      case ROLES.PROJECT_MANAGER:
        return 2;
      case ROLES.PROJECT_TRANSLATOR:
        return 3;
      case ROLES.PROJECT_OBSERVER:
        return 4;
      case ROLES.ORG_MEMBER:
        return 5;
      default:
        return 99;
    }
  }),
  findUserIdsInOrg: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

describe('project-users repository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getProjectUsers', () => {
    it('returns PROJECT_NOT_FOUND if the project does not exist', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      } as never);

      const result = await repo.getProjectUsers(999);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
      }
    });

    it('queries strictly by project-pinned grant (eq(user_roles.projectId, projectId))', async () => {
      // 1. Project lookup
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ organization: 1 }]),
          }),
        }),
      } as never);

      // 2. Rows lookup
      const mockRows = [
        {
          projectId: 10,
          userId: 101,
          displayName: 'project_pm',
          roleID: 2, // PROJECT_MANAGER
          roleName: ROLES.PROJECT_MANAGER,
          createdAt: new Date(),
        },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue(mockRows),
              }),
            }),
          }),
        }),
      } as never);

      const result = await repo.getProjectUsers(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].userId).toBe(101);
      }

      // Negative check: verify query strictly asserts eq(user_roles.projectId, 10)
      expect(eq).toHaveBeenCalledWith(user_roles.projectId, 10);
      expect(eq).toHaveBeenCalledWith(projects.id, 10);
    });

    it('deduplicates multiple project-pinned grants prioritizing PM > PT > PO', async () => {
      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ organization: 1 }]),
          }),
        }),
      } as never);

      const mockRows = [
        {
          projectId: 10,
          userId: 101,
          displayName: 'alice',
          roleID: 4, // PROJECT_OBSERVER (priority 1)
          roleName: ROLES.PROJECT_OBSERVER,
          createdAt: new Date(),
        },
        {
          projectId: 10,
          userId: 101,
          displayName: 'alice',
          roleID: 2, // PROJECT_MANAGER (priority 3)
          roleName: ROLES.PROJECT_MANAGER,
          createdAt: new Date(),
        },
      ];

      vi.mocked(db.select).mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue(mockRows),
              }),
            }),
          }),
        }),
      } as never);

      const result = await repo.getProjectUsers(10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].roleName).toBe(ROLES.PROJECT_MANAGER);
      }
    });
  });

  describe('updateProjectUserRole', () => {
    it('negative test: returns NOT_FOUND if roleId is not a project-level role (e.g. Org Manager)', async () => {
      // Role ID 1 is ORG_MANAGER, which is not in (PM, PT, PO)
      const result = await repo.updateProjectUserRole(10, 101, 1, ROLES.ORG_MANAGER, 99);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
      }
    });

    it('negative test: returns USER_NOT_IN_PROJECT when user has no project-pinned row (no fallback insert)', async () => {
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]), // 0 rows updated
            }),
          }),
        }),
        insert: vi.fn(), // Must NOT be called
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        return callback(tx as never);
      });

      const result = await repo.updateProjectUserRole(10, 999, 3, ROLES.PROJECT_TRANSLATOR, 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_PROJECT);
      }
      expect(tx.insert).not.toHaveBeenCalled();
    });

    it('positive test: successfully updates role for an explicitly pinned project user', async () => {
      const updatedRow = {
        projectId: 10,
        userId: 101,
        roleId: 2,
        createdAt: new Date(),
      };

      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([updatedRow]),
            }),
          }),
        }),
        select: vi.fn(),
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        return callback(tx as never);
      });

      const result = await repo.updateProjectUserRole(10, 101, 2, ROLES.PROJECT_MANAGER, 1);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({
          ...updatedRow,
          roleName: ROLES.PROJECT_MANAGER,
        });
      }
    });
  });

  describe('removeProjectUser', () => {
    it('negative test: returns USER_NOT_IN_PROJECT when deleting an unpinned user (e.g. unassigned Org Manager)', async () => {
      const tx = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // 0 rows deleted
          }),
        }),
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        return callback(tx as never);
      });

      const result = await repo.removeProjectUser(10, 999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_PROJECT);
      }
    });

    it('positive test: removes project user and clears assignments', async () => {
      const tx = {
        delete: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ userId: 101 }]),
          }),
        }),
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      };

      vi.mocked(db.transaction).mockImplementation(async (callback) => {
        return callback(tx as never);
      });

      const result = await repo.removeProjectUser(10, 101);

      expect(result.ok).toBe(true);
    });
  });
});
