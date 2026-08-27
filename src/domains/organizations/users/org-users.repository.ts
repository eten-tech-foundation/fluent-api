import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, projects, user_roles } from '@/db/schema';
import { logger } from '@/lib/logger';
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
