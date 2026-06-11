import { and, eq, isNull } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { roles, user_roles } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
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
    // PostgreSQL unique indexes don't treat NULL = NULL, so onConflictDoNothing
    // won't catch duplicate org-wide grants (where projectId is NULL).
    // Check explicitly before inserting.
    const [existing] = await db
      .select({ id: user_roles.id })
      .from(user_roles)
      .where(
        and(
          eq(user_roles.userId, input.userId),
          input.orgId === null ? isNull(user_roles.orgId) : eq(user_roles.orgId, input.orgId),
          input.projectId === null
            ? isNull(user_roles.projectId)
            : eq(user_roles.projectId, input.projectId),
          eq(user_roles.roleId, input.roleId)
        )
      )
      .limit(1);

    if (existing) return ok(undefined); // Already granted, nothing to do

    await db.insert(user_roles).values(input).onConflictDoNothing();
    return ok(undefined);
  } catch (error) {
    return handleConstraintError(error);
  }
}

/** Revoke a single (user, org, project, role) grant. Null scope values match NULL columns. */
export async function revokeRole(input: GrantInput): Promise<Result<void>> {
  try {
    await db
      .delete(user_roles)
      .where(
        and(
          eq(user_roles.userId, input.userId),
          input.orgId === null ? isNull(user_roles.orgId) : eq(user_roles.orgId, input.orgId),
          input.projectId === null
            ? isNull(user_roles.projectId)
            : eq(user_roles.projectId, input.projectId),
          eq(user_roles.roleId, input.roleId)
        )
      );
    return ok(undefined);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to revoke role', context: input });
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
