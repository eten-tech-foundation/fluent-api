import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { organizations, roles, user_roles } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type {
  CreateOrganizationInput,
  OrganizationRecord,
  OrganizationSummaryRecord,
} from './organizations.types';

function withManagerCounts() {
  const orgManagerCount =
    sql<number>`count(DISTINCT ${user_roles.userId}) FILTER (WHERE ${roles.name} = ${ROLES.ORG_MANAGER})::int`.as(
      'orgManagerCount'
    );

  return db
    .select({
      id: organizations.id,
      name: organizations.name,
      createdAt: organizations.createdAt,
      orgManagerCount,
    })
    .from(organizations)
    .leftJoin(user_roles, and(eq(user_roles.orgId, organizations.id), isNull(user_roles.projectId)))
    .leftJoin(roles, eq(roles.id, user_roles.roleId));
}

export async function findAllWithCounts(): Promise<Result<OrganizationSummaryRecord[]>> {
  try {
    const rows = await withManagerCounts()
      .groupBy(organizations.id, organizations.name, organizations.createdAt)
      .orderBy(organizations.name);
    return ok(rows);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to list organizations' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function findByIdWithCounts(
  id: number
): Promise<Result<OrganizationSummaryRecord | null>> {
  try {
    const [row] = await withManagerCounts()
      .where(eq(organizations.id, id))
      .groupBy(organizations.id, organizations.name, organizations.createdAt)
      .limit(1);
    return ok(row ?? null);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to find organization',
      context: { id },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function insert(input: CreateOrganizationInput): Promise<Result<OrganizationRecord>> {
  try {
    const [org] = await db.insert(organizations).values({ name: input.name }).returning({
      id: organizations.id,
      name: organizations.name,
      createdAt: organizations.createdAt,
    });
    if (!org) return err(ErrorCode.INTERNAL_ERROR);
    return ok(org);
  } catch (error) {
    return handleConstraintError(error);
  }
}
