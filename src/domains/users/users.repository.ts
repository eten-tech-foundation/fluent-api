import { eq, inArray, or } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { user_roles, users } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { CreateUserInput, UpdateUserInput, User } from './users.types';

export async function findAll(): Promise<Result<User[]>> {
  try {
    return ok(await db.select().from(users));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find all users' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByOrganizations(orgIds: number[]): Promise<Result<User[]>> {
  if (orgIds.length === 0) return ok([]);
  try {
    const rows = await db
      .selectDistinct({ user: users })
      .from(users)
      .innerJoin(user_roles, eq(users.id, user_roles.userId))
      .where(inArray(user_roles.orgId, orgIds));
    return ok(rows.map((r) => r.user));
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find users by organizations',
      context: { orgIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findById(id: number): Promise<Result<User>> {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return err(ErrorCode.USER_NOT_FOUND);
    return ok(user);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find user by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByIds(ids: number[]): Promise<Result<User[]>> {
  if (ids.length === 0) return ok([]);
  try {
    const rows = await db.select().from(users).where(inArray(users.id, ids));
    return ok(rows);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find users by IDs', context: { ids } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByEmail(email: string): Promise<Result<User>> {
  try {
    const [result] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!result) return err(ErrorCode.USER_NOT_FOUND);
    return ok(result);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find user by email', context: { email } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByUsername(username: string): Promise<Result<User>> {
  try {
    const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);
    if (!user) return err(ErrorCode.USER_NOT_FOUND);
    return ok(user);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find user by username',
      context: { username },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByEmailOrUsername(identifier: string): Promise<Result<User>> {
  try {
    const lower = identifier.toLowerCase();
    const [user] = await db
      .select()
      .from(users)
      .where(or(eq(users.email, lower), eq(users.username, identifier)))
      .limit(1);
    if (!user) return err(ErrorCode.USER_NOT_FOUND);
    return ok(user);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find user by email or username',
      context: { identifier },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insert(input: CreateUserInput): Promise<Result<User>> {
  try {
    // Strip grant-specific fields and legacy fields that don't belong on the users table
    const {
      orgId: _orgId,
      projectId: _projectId,
      roleName: _roleName,
      role: _role,
      organization: _org,
      grants: _grants,
      ...userData
    } = input as any;
    const [user] = await db
      .insert(users)
      .values({ ...userData, email: input.email.toLowerCase() })
      .returning();
    if (!user) return err(ErrorCode.INTERNAL_ERROR);
    return ok(user);
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function update(id: number, input: UpdateUserInput): Promise<Result<User>> {
  try {
    // Strip legacy fields that don't belong on the users table
    const { role: _role, organization: _org, ...cleanInput } = input as any;
    const updateInput = cleanInput.email
      ? { ...cleanInput, email: cleanInput.email.toLowerCase() }
      : cleanInput;
    const [updated] = await db.update(users).set(updateInput).where(eq(users.id, id)).returning();
    if (!updated) return err(ErrorCode.USER_NOT_FOUND);
    return ok(updated);
  } catch (error) {
    return handleConstraintError(error);
  }
}

export async function remove(id: number): Promise<Result<void>> {
  try {
    const [deleted] = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (!deleted) return err(ErrorCode.USER_NOT_FOUND);
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to remove user', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
