import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, projects, user_roles } from '@/db/schema';
import { getRoleId } from '@/domains/user-roles/user-roles.service';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

/**
 * Removes a user entirely from an org in a single transaction:
 *
 * 1. Across every project in the org, clear the user as assignedUserId / peerCheckerId
 *    on any chapter_assignments they currently hold.
 * 2. Delete all user_roles grants for that user in this org
 *    (anchor row + every project-scoped or org-scoped grant).
 *
 * The user's account and any grants in other orgs are unaffected.
 * Per 2026-07-02 spec §"Remove from org".
 */
class UserNotInOrgException extends Error {}

export async function removeOrgUser(orgId: number, userId: number): Promise<Result<void>> {
  try {
    return await db.transaction(async (tx) => {
      // 1. Find all projects in this org.
      const orgProjects = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.organization, orgId));

      if (orgProjects.length > 0) {
        const projectIds = orgProjects.map((p) => p.id);

        // 2. Collect all chapter_assignment IDs in those projects where the user is assigned.
        const affectedIds = await tx
          .select({ id: chapter_assignments.id })
          .from(chapter_assignments)
          .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
          .where(
            and(
              inArray(project_units.projectId, projectIds),
              sql`(${chapter_assignments.assignedUserId} = ${userId} OR ${chapter_assignments.peerCheckerId} = ${userId})`
            )
          );

        // 3. Null out the user's drafter / peer-checker columns on those assignments.
        if (affectedIds.length > 0) {
          const ids = affectedIds.map((r) => r.id);
          await tx
            .update(chapter_assignments)
            .set({
              assignedUserId: sql`CASE WHEN ${chapter_assignments.assignedUserId} = ${userId} THEN NULL ELSE ${chapter_assignments.assignedUserId} END`,
              peerCheckerId: sql`CASE WHEN ${chapter_assignments.peerCheckerId} = ${userId} THEN NULL ELSE ${chapter_assignments.peerCheckerId} END`,
            })
            .where(inArray(chapter_assignments.id, ids));
        }
      }

      // 4. Delete all user_roles rows for this user in this org
      //    (covers anchor row where projectId IS NULL, plus every project-scoped grant).
      const deleted = await tx
        .delete(user_roles)
        .where(and(eq(user_roles.userId, userId), eq(user_roles.orgId, orgId)))
        .returning({ id: user_roles.id });

      if (deleted.length === 0) {
        throw new UserNotInOrgException('User not in organization');
      }

      return ok(undefined);
    });
  } catch (error) {
    if (error instanceof UserNotInOrgException) {
      return err(ErrorCode.USER_NOT_IN_ORGANIZATION);
    }
    logger.error({
      cause: error,
      message: 'Failed to remove user from org',
      context: { orgId, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

/**
 * Updates a user's org-level role within an org in a single transaction.
 *
 * Org-level roles live on grant rows with projectId IS NULL. The Org Member
 * row is the membership anchor and is never touched here; every other
 * org-level row is the functional org role (Org Manager today).
 *
 * - roleId === orgMemberRoleId → demotion: delete all non-anchor org-level rows.
 * - otherwise → replace the non-anchor org-level row set with a single row for
 *   roleId (idempotent when the role is unchanged).
 *
 * Project-scoped grants (projectId IS NOT NULL) are never affected — a PM who
 * is demoted from Org Manager keeps their project role, and vice versa.
 */
export async function updateOrgUserRole(
  orgId: number,
  userId: number,
  roleId: number,
  createdBy: number | null
): Promise<Result<void>> {
  try {
    const orgMemberRoleId = await getRoleId(ROLES.ORG_MEMBER);

    return await db.transaction(async (tx) => {
      // Lock the Org Member anchor first — it is the membership record, and
      // the row lock serializes this update against a concurrent
      // removeOrgUser: either we hold the anchor before removal deletes it,
      // or removal already committed and we bail out as not-a-member.
      const anchor = await tx
        .select({ id: user_roles.id })
        .from(user_roles)
        .where(
          and(
            eq(user_roles.userId, userId),
            eq(user_roles.orgId, orgId),
            isNull(user_roles.projectId),
            eq(user_roles.roleId, orgMemberRoleId)
          )
        )
        .for('update');

      if (anchor.length === 0) {
        throw new UserNotInOrgException('User not in organization');
      }

      const nonAnchorOrgScope = and(
        eq(user_roles.userId, userId),
        eq(user_roles.orgId, orgId),
        isNull(user_roles.projectId),
        sql`${user_roles.roleId} != ${orgMemberRoleId}`
      );

      if (roleId === orgMemberRoleId) {
        await tx.delete(user_roles).where(nonAnchorOrgScope);
        return ok(undefined);
      }

      const existing = await tx
        .select({ id: user_roles.id, roleId: user_roles.roleId })
        .from(user_roles)
        .where(nonAnchorOrgScope);

      if (existing.length === 1 && existing[0].roleId === roleId) {
        return ok(undefined);
      }

      if (existing.length > 0) {
        await tx.delete(user_roles).where(
          inArray(
            user_roles.id,
            existing.map((r) => r.id)
          )
        );
      }

      await tx
        .insert(user_roles)
        .values({ userId, orgId, projectId: null, roleId, createdBy })
        .onConflictDoNothing();

      return ok(undefined);
    });
  } catch (error) {
    if (error instanceof UserNotInOrgException) {
      return err(ErrorCode.USER_NOT_IN_ORGANIZATION);
    }
    logger.error({
      cause: error,
      message: 'Failed to update org-level role for user',
      context: { orgId, userId, roleId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
