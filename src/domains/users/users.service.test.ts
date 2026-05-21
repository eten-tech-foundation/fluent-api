import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorMessages } from '@/lib/types';
import { resetAllMocks, sampleUsers } from '@/test/utils/test-helpers';

import {
  createUser,
  deleteUser,
  getAllUsers,
  getUserByEmail,
  getUserByEmailOrUsername,
  getUserById,
  getUserByUsername,
  getUsersByOrganization,
  toUserResponse,
  updateUser,
} from './users.service';

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe('user Service Functions', () => {
  const mockUser = sampleUsers.user1;
  const mockUserInput = sampleUsers.newUser;
  const updateData = sampleUsers.updateUser;

  beforeEach(() => {
    resetAllMocks();
  });

  describe('getAllUsers', () => {
    it('should return all users mapped to response shape', async () => {
      const mockUsers = [mockUser];
      (db.select as any).mockReturnValue({ from: vi.fn().mockResolvedValue(mockUsers) });

      const result = await getAllUsers();

      expect(result).toEqual({ ok: true, data: mockUsers.map(toUserResponse) });
    });

    it('should return an error result if db call throws', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockRejectedValue(new Error('DB error')),
      });

      const result = await getAllUsers();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.INTERNAL_ERROR);
      }
    });
  });

  describe('getUsersByOrganization', () => {
    it('should return users by organization mapped to response shape', async () => {
      const mockUsers = [mockUser];
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(mockUsers),
        }),
      });

      const result = await getUsersByOrganization(1);

      expect(result).toEqual({ ok: true, data: mockUsers.map(toUserResponse) });
    });

    it('should return an error result if db call throws', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockRejectedValue(new Error('DB error')),
        }),
      });

      const result = await getUsersByOrganization(999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.INTERNAL_ERROR);
      }
    });
  });

  describe('getUserById', () => {
    it('should return user by ID mapped to response shape', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) }),
        }),
      });

      const result = await getUserById(mockUser.id);

      expect(result).toEqual({ ok: true, data: toUserResponse(mockUser) });
    });

    it('should return an error result when user not found', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const result = await getUserById(999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });

  describe('getUserByEmail', () => {
    it('should return user by email with roleName mapped to response shape', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ user: mockUser, roleName: 'Manager' }]),
            }),
          }),
        }),
      });

      const result = await getUserByEmail(mockUser.email);

      expect(result).toEqual({
        ok: true,
        data: { ...toUserResponse(mockUser), roleName: 'Manager' },
      });
    });

    it('should convert email to lowercase before querying', async () => {
      const whereMock = vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ user: mockUser, roleName: 'Manager' }]),
      });
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({ where: whereMock }),
        }),
      });

      await getUserByEmail('TEST@EXAMPLE.COM');
      expect(whereMock).toHaveBeenCalled();
    });

    it('should return an error result when user not found', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
          }),
        }),
      });

      const result = await getUserByEmail('noone@example.com');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });

  describe('getUserByUsername', () => {
    it('should return user by username mapped to response shape', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) }),
        }),
      });

      const result = await getUserByUsername(mockUser.username);

      expect(result).toEqual({ ok: true, data: toUserResponse(mockUser) });
    });

    it('should return an error result when user not found', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const result = await getUserByUsername('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });

  describe('getUserByEmailOrUsername', () => {
    it('should return user by email or username mapped to response shape', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) }),
        }),
      });

      const result = await getUserByEmailOrUsername(mockUser.email);

      expect(result).toEqual({ ok: true, data: toUserResponse(mockUser) });
    });

    it('should convert identifier to lowercase for email lookups', async () => {
      const whereMock = vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([mockUser]) });
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({ where: whereMock }),
      });

      await getUserByEmailOrUsername('TEST@EXAMPLE.COM');
      expect(whereMock).toHaveBeenCalled();
    });

    it('should return an error result when user not found', async () => {
      (db.select as any).mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const result = await getUserByEmailOrUsername('noone@example.com');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });

  describe('createUser', () => {
    it('should create and return a new user mapped to response shape', async () => {
      const createdUser = {
        ...mockUserInput,
        id: 2,
        createdAt: new Date(),
        updatedAt: new Date(),
        email: mockUserInput.email.toLowerCase(),
        authUserId: null,
      };
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([createdUser]) }),
      });

      const result = await createUser(mockUserInput);

      expect(result).toEqual({ ok: true, data: toUserResponse(createdUser) });
    });

    it('should convert email to lowercase before inserting', async () => {
      const valuesMock = vi
        .fn()
        .mockReturnValue({ returning: vi.fn().mockResolvedValue([mockUser]) });
      (db.insert as any).mockReturnValue({ values: valuesMock });

      const inputWithUppercaseEmail = { ...mockUserInput, email: 'NEWUSER@EXAMPLE.COM' };
      await createUser(inputWithUppercaseEmail);

      expect(valuesMock).toHaveBeenCalledWith({
        ...inputWithUppercaseEmail,
        email: 'newuser@example.com',
      });
    });

    it('should return an error result if db returns no rows', async () => {
      (db.insert as any).mockReturnValue({
        values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      });

      const result = await createUser(mockUserInput);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.INTERNAL_ERROR);
      }
    });
  });

  describe('updateUser', () => {
    it('should update and return the user mapped to response shape', async () => {
      const updatedUser = { ...mockUser, ...updateData };
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([updatedUser]) }),
        }),
      });

      const result = await updateUser(mockUser.id, updateData);

      expect(result).toEqual({ ok: true, data: toUserResponse(updatedUser) });
    });

    it('should convert email to lowercase when updating', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([mockUser]) }),
      });
      (db.update as any).mockReturnValue({ set: setMock });

      const updateWithEmail = { email: 'UPDATED@EXAMPLE.COM' };
      await updateUser(mockUser.id, updateWithEmail);

      expect(setMock).toHaveBeenCalledWith({ email: 'updated@example.com' });
    });

    it('should not modify input when no email is provided', async () => {
      const setMock = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([mockUser]) }),
      });
      (db.update as any).mockReturnValue({ set: setMock });

      await updateUser(mockUser.id, updateData);

      expect(setMock).toHaveBeenCalledWith(updateData);
    });

    it('should return an error result when user to update is not found', async () => {
      (db.update as any).mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
        }),
      });

      const result = await updateUser(999, updateData);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });

  describe('deleteUser', () => {
    it('should delete the user and return a success result', async () => {
      (db.delete as any).mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: mockUser.id }]) }),
      });

      const result = await deleteUser(mockUser.id);

      expect(result).toEqual({ ok: true, data: undefined });
    });

    it('should return an error result when user to delete is not found', async () => {
      (db.delete as any).mockReturnValue({
        where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([]) }),
      });

      const result = await deleteUser(999);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(ErrorMessages.USER_NOT_FOUND);
      }
    });
  });
});
