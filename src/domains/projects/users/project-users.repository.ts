import { and, eq, inArray, or } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { chapter_assignments, project_units, project_users, users } from '@/db/schema';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUserRecord } from './project-users.types';

function handleUniqueConstraintError(error: unknown): boolean {
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code === '23505';
  }
  return false;
}

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
  } catch (e) {
    logger.error({
      cause: e,
      message: 'Failed to get project users',
      context: { projectId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function addProjectUsers(
  projectId: number,
  userIds: number[]
): Promise<Result<ProjectUserRecord[]>> {
  try {
    const userRows = await db
      .select({ id: users.id, username: users.username, role: users.role })
      .from(users)
      .where(inArray(users.id, userIds));

    const foundIds = new Set(userRows.map((u) => u.id));
    const missingId = userIds.find((id) => !foundIds.has(id));
    if (missingId) return err(ErrorCode.USER_NOT_FOUND);

    const inserted = await db
      .insert(project_users)
      .values(userIds.map((userId) => ({ projectId, userId })))
      .onConflictDoNothing()
      .returning();

    const userMap = new Map(userRows.map((u) => [u.id, u]));

    return ok(
      inserted.map((row) => ({
        projectId: row.projectId,
        userId: row.userId,
        displayName: userMap.get(row.userId)!.username,
        roleID: userMap.get(row.userId)!.role,
        createdAt: row.createdAt,
      }))
    );
  } catch (e) {
    if (handleUniqueConstraintError(e)) {
      return err(ErrorCode.USER_ALREADY_IN_PROJECT);
    }
    logger.error({
      cause: e,
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
  } catch (e) {
    logger.error({
      cause: e,
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
