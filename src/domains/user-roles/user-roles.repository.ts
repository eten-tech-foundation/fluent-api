import { and, eq, inArray } from 'drizzle-orm';

import type { Permission } from '@/lib/permissions';
import type { Grant, Result } from '@/lib/types';

import { db } from '@/db';
import { permissions, role_permissions, user_roles } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

export interface GrantRow {
  orgId: number | null;
  projectId: number | null;
  permission: string;
}

const key = (orgId: number | null, projectId: number | null): string =>
  `${orgId ?? 'null'}:${projectId ?? 'null'}`;

/** Pure: fold flat (scope, permission) rows into one Grant per distinct scope. */
export function groupGrantRows(rows: GrantRow[]): Grant[] {
  const byScope = new Map<
    string,
    { orgId: number | null; projectId: number | null; permissions: Set<Permission> }
  >();
  for (const row of rows) {
    const k = key(row.orgId, row.projectId);
    let entry = byScope.get(k);
    if (!entry) {
      entry = { orgId: row.orgId, projectId: row.projectId, permissions: new Set<Permission>() };
      byScope.set(k, entry);
    }
    entry.permissions.add(row.permission as Permission);
  }
  return [...byScope.values()];
}

export async function findGrantsByUserId(userId: number): Promise<Result<Grant[]>> {
  try {
    const rows = await db
      .select({
        orgId: user_roles.orgId,
        projectId: user_roles.projectId,
        permission: permissions.name,
      })
      .from(user_roles)
      .innerJoin(role_permissions, eq(role_permissions.roleId, user_roles.roleId))
      .innerJoin(permissions, eq(permissions.id, role_permissions.permissionId))
      .where(eq(user_roles.userId, userId));
    return ok(groupGrantRows(rows));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to load grants', context: { userId } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findOrgIdsForUser(userId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ orgId: user_roles.orgId })
    .from(user_roles)
    .where(eq(user_roles.userId, userId));
  return rows.map((r) => r.orgId).filter((x): x is number => x !== null);
}

export async function findUserIdsInOrg(orgId: number, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .selectDistinct({ userId: user_roles.userId })
    .from(user_roles)
    .where(and(eq(user_roles.orgId, orgId), inArray(user_roles.userId, userIds)));
  return new Set(rows.map((r) => r.userId));
}
