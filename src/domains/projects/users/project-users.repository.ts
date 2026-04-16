import { and, eq, or } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, project_users, users } from '@/db/schema';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUserRecord } from './project-users.types';

// Repository functions

export async function getProjectUsers(projectId: number): Promise<Result<ProjectUserRecord[]>> {
  try {
    const rows = await db
      .select({
        projectId: project_users.projectId,
        userId: project_users.userId,
        displayName: users.username,
        roleID: users.role,
        createdAt: project_users.createdAt,
      })
      .from(project_users)
      .innerJoin(users, eq(project_users.userId, users.id))
      .where(eq(project_users.projectId, projectId))
      .orderBy(users.username);

    return ok(rows);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to get project users',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function addProjectUsers(
  projectId: number,
  userIds: number[]
): Promise<Result<{ projectId: number; userId: number; createdAt: Date | null }[]>> {
  if (userIds.length === 0) return ok([]);
  try {
    const inserted = await db
      .insert(project_users)
      .values(userIds.map((userId) => ({ projectId, userId })))
      .onConflictDoNothing()
      .returning({
        projectId: project_users.projectId,
        userId: project_users.userId,
        createdAt: project_users.createdAt,
      });

    return ok(inserted);
  } catch (error) {
    const constraintResult = handleConstraintError(error);
    if (!constraintResult.ok && constraintResult.error.code === ErrorCode.DUPLICATE) {
      return err(ErrorCode.USER_ALREADY_IN_PROJECT);
    }
    logger.error({
      cause: error,
      message: 'Failed to bulk add users to project',
      context: { projectId, userIds },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function removeProjectUser(projectId: number, userId: number): Promise<Result<void>> {
  try {
    const [assignedContent] = await db
      .select({ userId: chapter_assignments.assignedUserId })
      .from(chapter_assignments)
      .innerJoin(project_units, eq(chapter_assignments.projectUnitId, project_units.id))
      .where(
        and(
          eq(project_units.projectId, projectId),
          or(
            eq(chapter_assignments.assignedUserId, userId),
            eq(chapter_assignments.peerCheckerId, userId)
          )
        )
      )
      .limit(1);

    if (assignedContent) return err(ErrorCode.USER_HAS_ASSIGNED_CONTENT);

    const deleted = await db
      .delete(project_users)
      .where(and(eq(project_users.projectId, projectId), eq(project_users.userId, userId)))
      .returning({ userId: project_users.userId });

    if (deleted.length === 0) return err(ErrorCode.USER_NOT_IN_PROJECT);

    return ok(undefined);
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to remove user from project',
      context: { projectId, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function resolveIsProjectMember(
  projectId: number,
  userId: number,
  roleName: string
): Promise<boolean> {
  if (roleName !== ROLES.TRANSLATOR) return false;

  const [member] = await db
    .select({ projectId: project_users.projectId })
    .from(project_users)
    .where(and(eq(project_users.projectId, projectId), eq(project_users.userId, userId)))
    .limit(1);

  return member !== undefined;
}
