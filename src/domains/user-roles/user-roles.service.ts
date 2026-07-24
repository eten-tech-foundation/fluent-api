import { and, eq, isNull } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { roles, user_roles } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

export interface GrantInput {
  userId: number;
  orgId: number | null;
  projectId: number | null;
  roleId: number;
  createdBy?: number | null;
}

export async function grantRole(input: GrantInput): Promise<Result<void>> {
  try {
    // Pre-check existence to avoid bumping the ID sequence unnecessarily on duplicates.
    await db
      .insert(user_roles)
      .values({
        userId: input.userId,
        orgId: input.orgId,
        projectId: input.projectId,
        roleId: input.roleId,
        createdBy: input.createdBy,
      })
      .onConflictDoNothing();
    return ok(undefined);
  } catch (error) {
    return handleConstraintError(error, ErrorCode.CONFLICT);
  }
}

export async function revokeRole(
  userId: number,
  roleId: number,
  orgId?: number | null,
  projectId?: number | null
): Promise<Result<void>> {
  try {
    const conditions = [eq(user_roles.userId, userId), eq(user_roles.roleId, roleId)];
    if (orgId !== undefined) {
      conditions.push(orgId === null ? isNull(user_roles.orgId) : eq(user_roles.orgId, orgId));
    }
    if (projectId !== undefined) {
      conditions.push(
        projectId === null ? isNull(user_roles.projectId) : eq(user_roles.projectId, projectId)
      );
    }

    await db.delete(user_roles).where(and(...conditions));
    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to revoke role',
      context: { userId, roleId, orgId, projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

const roleIdCache = new Map<string, number>();
export async function getRoleId(name: string): Promise<number> {
  const cached = roleIdCache.get(name);
  if (cached) return cached;
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1);
  if (!row) throw new Error(`Role not found: ${name}`);
  roleIdCache.set(name, row.id);
  return row.id;
}

export async function inviteUserToOrg(
  userId: number,
  orgId: number,
  createdBy: number | null
): Promise<Result<void>> {
  try {
    const roleId = await getRoleId(ROLES.ORG_MEMBER);
    return grantRole({ userId, orgId, projectId: null, roleId, createdBy });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to create org member anchor row',
      context: { userId, orgId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
