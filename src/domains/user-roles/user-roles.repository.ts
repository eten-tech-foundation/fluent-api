import { and, eq, inArray } from 'drizzle-orm';

import type { Permission } from '@/lib/permissions';
import type { Grant, Result } from '@/lib/types';

import { db } from '@/db';
import { organizations, permissions, role_permissions, roles, user_roles } from '@/db/schema';
import { logger } from '@/lib/logger';
import { isPermission } from '@/lib/permissions';
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
    if (!isPermission(row.permission)) {
      logger.warn({ permission: row.permission }, 'Ignoring unknown permission from DB');
      continue;
    }
    const k = key(row.orgId, row.projectId);
    let entry = byScope.get(k);
    if (!entry) {
      entry = { orgId: row.orgId, projectId: row.projectId, permissions: new Set<Permission>() };
      byScope.set(k, entry);
    }
    entry.permissions.add(row.permission);
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

    logger.debug({ userId, rowsCount: rows.length, rows }, 'DB rows for findGrantsByUserId');
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

export async function findRoleGrantsByUserIds(
  userIds: number[],
  filterOrgIds: number[] | 'ALL'
): Promise<
  Map<
    number,
    Array<{
      roleId: number;
      roleName: string;
      orgId: number | null;
      projectId: number | null;
      orgName: string | null;
    }>
  >
> {
  if (userIds.length === 0) return new Map();

  const conditions = [inArray(user_roles.userId, userIds)];
  if (filterOrgIds !== 'ALL') {
    if (filterOrgIds.length === 0) return new Map();
    conditions.push(inArray(user_roles.orgId, filterOrgIds));
  }

  const rows = await db
    .select({
      userId: user_roles.userId,
      orgId: user_roles.orgId,
      projectId: user_roles.projectId,
      roleId: roles.id,
      roleName: roles.name,
      orgName: organizations.name,
    })
    .from(user_roles)
    .innerJoin(roles, eq(roles.id, user_roles.roleId))
    .leftJoin(organizations, eq(organizations.id, user_roles.orgId))
    .where(and(...conditions));

  const map = new Map<
    number,
    Array<{
      roleId: number;
      roleName: string;
      orgId: number | null;
      projectId: number | null;
      orgName: string | null;
    }>
  >();
  for (const row of rows) {
    if (!map.has(row.userId)) map.set(row.userId, []);
    map.get(row.userId)!.push({
      roleId: row.roleId,
      roleName: row.roleName,
      orgId: row.orgId,
      projectId: row.projectId,
      orgName: row.orgName,
    });
  }

  logger.debug(
    {
      userIds,
      filterOrgIds,
      result: Array.from(map.entries()),
    },
    'findRoleGrantsByUserIds returning map'
  );

  return map;
}
