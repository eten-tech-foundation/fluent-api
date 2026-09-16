import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import type { ChapterAssignmentStatus } from '@/domains/chapter-assignments/chapter-assignments.types';
import type { DbTransaction, Result } from '@/lib/types';

import { db } from '@/db';
import {
  bible_texts,
  chapter_assignments,
  project_units,
  projects,
  roles,
  translated_verses,
  user_roles,
  users,
} from '@/db/schema';
import {
  insertStatusHistory,
  insertUserAssignmentHistory,
} from '@/domains/chapter-assignments/chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { findUserIdsInOrg } from '@/domains/user-roles/user-roles.repository';
import { getRoleId } from '@/domains/user-roles/user-roles.service';
import { handleConstraintError } from '@/lib/db-errors';
import { logger } from '@/lib/logger';
import { ROLES } from '@/lib/roles';
import { err, ErrorCode, ok } from '@/lib/types';

import type { ProjectUserRecord } from './project-users.types';

// Repository functions

export async function getProjectUsers(projectId: number): Promise<Result<ProjectUserRecord[]>> {
  try {
    const [project] = await db
      .select({ organization: projects.organization })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

    // Exclude the Org Member anchor role (zero permissions, backend-only, never shown in UI).
    const orgMemberRoleId = await getRoleId(ROLES.ORG_MEMBER);

    const rows = await db
      .select({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        displayName: users.username,
        roleID: user_roles.roleId,
        roleName: roles.name,
        createdAt: user_roles.createdAt,
      })
      .from(user_roles)
      .innerJoin(users, eq(user_roles.userId, users.id))
      .innerJoin(roles, eq(roles.id, user_roles.roleId))
      .where(
        and(
          // Include project-pinned grants for this project OR org-wide grants for the project's org.
          or(
            eq(user_roles.projectId, projectId),
            and(isNull(user_roles.projectId), eq(user_roles.orgId, project.organization))
          ),
          // Exclude Org Member anchor rows — they carry zero permissions and are not displayed.
          sql`${user_roles.roleId} != ${orgMemberRoleId}`
        )
      )
      .orderBy(users.username);

    const [orgMgrId, pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.ORG_MANAGER),
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const rolePriorityMap = new Map<number, number>([
      [orgMgrId, 4],
      [pmId, 3],
      [ptId, 2],
      [poId, 1],
    ]);
    const getRolePriority = (roleId: number) => rolePriorityMap.get(roleId) ?? 0;

    const uniqueUsers = new Map<number, (typeof rows)[number]>();
    for (const r of rows) {
      const existing = uniqueUsers.get(r.userId);
      if (
        !existing ||
        (r.projectId !== null && existing.projectId === null) ||
        (Boolean(r.projectId) === Boolean(existing.projectId) &&
          getRolePriority(r.roleID) > getRolePriority(existing.roleID))
      ) {
        uniqueUsers.set(r.userId, r);
      }
    }

    // Map `projectId: null` to `projectId` for the UI.
    const projectUsers = Array.from(uniqueUsers.values()).map((r) => ({
      ...r,
      projectId: r.projectId ?? projectId,
    }));
    return ok(projectUsers as any);
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
  createdBy: number | null,
  projectId: number,
  userIds: number[],
  roleId: number,
  roleName: string
): Promise<
  Result<
    {
      projectId: number;
      userId: number;
      roleId: number;
      roleName: string;
      createdAt: Date | null;
    }[]
  >
> {
  if (userIds.length === 0) return ok([]);
  try {
    const [project] = await db
      .select({ organization: projects.organization })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

    // Verify all userIds belong to the project's organization to prevent cross-tenant membership leaks
    const memberIds = await findUserIdsInOrg(project.organization, userIds);
    const nonMember = userIds.find((id) => !memberIds.has(id));
    if (nonMember) {
      return err(ErrorCode.USER_NOT_FOUND);
    }

    // Validate that the provided roleId is one of the three project-level roles
    const [pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const validProjectRoleIds = new Set([pmId, ptId, poId]);
    if (!validProjectRoleIds.has(roleId)) {
      return err(ErrorCode.NOT_FOUND);
    }

    const inserted = await db
      .insert(user_roles)
      .values(
        userIds.map((userId) => ({
          projectId,
          userId,
          orgId: project.organization,
          roleId,
          createdBy,
        }))
      )
      .returning({
        projectId: user_roles.projectId,
        userId: user_roles.userId,
        roleId: user_roles.roleId,
        createdAt: user_roles.createdAt,
      });

    return ok(inserted.map((r) => ({ ...r, roleName })) as any);
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

async function clearUserAssignmentsAndRecordHistory(
  tx: DbTransaction,
  unitIds: number[],
  userId: number
): Promise<void> {
  if (unitIds.length === 0) return;

  const affectedAssignments = await tx
    .select({
      id: chapter_assignments.id,
      bibleId: chapter_assignments.bibleId,
      bookId: chapter_assignments.bookId,
      chapterNumber: chapter_assignments.chapterNumber,
      projectUnitId: chapter_assignments.projectUnitId,
      status: chapter_assignments.status,
      assignedUserId: chapter_assignments.assignedUserId,
      peerCheckerId: chapter_assignments.peerCheckerId,
    })
    .from(chapter_assignments)
    .where(
      and(
        inArray(chapter_assignments.projectUnitId, unitIds),
        or(
          eq(chapter_assignments.assignedUserId, userId),
          eq(chapter_assignments.peerCheckerId, userId)
        )
      )
    );

  if (affectedAssignments.length === 0) return;

  await tx
    .update(chapter_assignments)
    .set({
      assignedUserId: null,
      status: sql`CASE 
        WHEN EXISTS (
          SELECT 1 FROM ${translated_verses} tv 
          JOIN ${bible_texts} bt ON tv.bible_text_id = bt.id 
          WHERE bt.bible_id = ${chapter_assignments.bibleId} 
            AND bt.book_id = ${chapter_assignments.bookId} 
            AND bt.chapter_number = ${chapter_assignments.chapterNumber} 
            AND tv.project_unit_id = ${chapter_assignments.projectUnitId} 
            AND tv.content != ''
        ) THEN ${chapter_assignments.status}
        ELSE ${CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED}
      END`,
    })
    .where(
      and(
        inArray(chapter_assignments.projectUnitId, unitIds),
        eq(chapter_assignments.assignedUserId, userId),
        inArray(chapter_assignments.status, [
          CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
          CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        ])
      )
    );

  await tx
    .update(chapter_assignments)
    .set({
      peerCheckerId: null,
    })
    .where(
      and(
        inArray(chapter_assignments.projectUnitId, unitIds),
        eq(chapter_assignments.peerCheckerId, userId),
        inArray(chapter_assignments.status, [
          CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
          CHAPTER_ASSIGNMENT_STATUS.DRAFT,
          CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
        ])
      )
    );

  for (const ca of affectedAssignments) {
    const isDrafterRemovable =
      ca.assignedUserId === userId &&
      (ca.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED ||
        ca.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT);

    const isCheckerRemovable =
      ca.peerCheckerId === userId &&
      (ca.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED ||
        ca.status === CHAPTER_ASSIGNMENT_STATUS.DRAFT ||
        ca.status === CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);

    if (isDrafterRemovable) {
      const [hasContentRow] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(translated_verses)
        .innerJoin(bible_texts, eq(translated_verses.bibleTextId, bible_texts.id))
        .where(
          and(
            eq(bible_texts.bibleId, ca.bibleId),
            eq(bible_texts.bookId, ca.bookId),
            eq(bible_texts.chapterNumber, ca.chapterNumber),
            eq(translated_verses.projectUnitId, ca.projectUnitId),
            sql`${translated_verses.content} != ''`
          )
        );

      const hasContent = Number(hasContentRow?.count ?? 0) > 0;
      const resultingStatus = hasContent
        ? (ca.status as ChapterAssignmentStatus)
        : (CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED as ChapterAssignmentStatus);

      await insertUserAssignmentHistory(tx, ca.id, userId, 'drafter', resultingStatus);

      if (resultingStatus !== ca.status) {
        await insertStatusHistory(tx, ca.id, resultingStatus);
      }
    }

    if (isCheckerRemovable) {
      await insertUserAssignmentHistory(
        tx,
        ca.id,
        userId,
        'peer_checker',
        ca.status as ChapterAssignmentStatus
      );
    }
  }
}

export async function removeProjectUser(projectId: number, userId: number): Promise<Result<void>> {
  try {
    return await db.transaction(async (tx) => {
      const deleted = await tx
        .delete(user_roles)
        .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
        .returning({ userId: user_roles.userId });

      if (deleted.length === 0) return err(ErrorCode.USER_NOT_IN_PROJECT);

      const unitRows = await tx
        .select({ id: project_units.id })
        .from(project_units)
        .where(eq(project_units.projectId, projectId));

      const unitIds = unitRows.map((u) => u.id);
      await clearUserAssignmentsAndRecordHistory(tx, unitIds, userId);

      return ok(undefined);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to remove user from project',
      context: { projectId, userId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function resolveIsProjectMember(projectId: number, userId: number): Promise<boolean> {
  const [pinned] = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .where(and(eq(user_roles.userId, userId), eq(user_roles.projectId, projectId)))
    .limit(1);
  if (pinned) return true;

  const rows = await db
    .select({ id: user_roles.id })
    .from(user_roles)
    .innerJoin(projects, eq(projects.id, projectId))
    .where(
      and(
        eq(user_roles.userId, userId),
        eq(user_roles.orgId, projects.organization),
        isNull(user_roles.projectId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function getProjectUserRole(
  projectId: number,
  userId: number
): Promise<number | null> {
  const [row] = await db
    .select({ roleId: user_roles.roleId })
    .from(user_roles)
    .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
    .limit(1);
  return row ? row.roleId : null;
}

export async function updateProjectUserRole(
  projectId: number,
  userId: number,
  roleId: number,
  roleName: string,
  createdBy: number | null
): Promise<
  Result<{
    projectId: number;
    userId: number;
    roleId: number;
    roleName: string;
    createdAt: Date | null;
  }>
> {
  try {
    // Validate that the provided roleId is one of the three project-level roles
    const [pmId, ptId, poId] = await Promise.all([
      getRoleId(ROLES.PROJECT_MANAGER),
      getRoleId(ROLES.PROJECT_TRANSLATOR),
      getRoleId(ROLES.PROJECT_OBSERVER),
    ]);
    const validProjectRoleIds = new Set([pmId, ptId, poId]);
    if (!validProjectRoleIds.has(roleId)) {
      return err(ErrorCode.NOT_FOUND);
    }

    return await db.transaction(async (tx) => {
      if (roleId === poId) {
        const unitRows = await tx
          .select({ id: project_units.id })
          .from(project_units)
          .where(eq(project_units.projectId, projectId));

        const unitIds = unitRows.map((u) => u.id);
        await clearUserAssignmentsAndRecordHistory(tx, unitIds, userId);
      }

      const [updated] = await tx
        .update(user_roles)
        .set({ roleId })
        .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
        .returning({
          projectId: user_roles.projectId,
          userId: user_roles.userId,
          roleId: user_roles.roleId,
          createdAt: user_roles.createdAt,
        });

      if (updated) {
        return ok({ ...updated, roleName } as any);
      }

      // If no project-pinned row exists, check if the user is a member of the project
      const [project] = await tx
        .select({ organization: projects.organization })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project) return err(ErrorCode.PROJECT_NOT_FOUND);

      const isMember = await resolveIsProjectMember(projectId, userId);
      if (!isMember) {
        return err(ErrorCode.USER_NOT_IN_PROJECT);
      }

      // Insert project-pinned grant row for this user
      const [inserted] = await tx
        .insert(user_roles)
        .values({
          userId,
          orgId: project.organization,
          projectId,
          roleId,
          createdBy,
        })
        .onConflictDoNothing()
        .returning({
          projectId: user_roles.projectId,
          userId: user_roles.userId,
          roleId: user_roles.roleId,
          createdAt: user_roles.createdAt,
        });

      if (!inserted) {
        const [existingRow] = await tx
          .select({
            projectId: user_roles.projectId,
            userId: user_roles.userId,
            roleId: user_roles.roleId,
            createdAt: user_roles.createdAt,
          })
          .from(user_roles)
          .where(and(eq(user_roles.projectId, projectId), eq(user_roles.userId, userId)))
          .limit(1);

        if (!existingRow) return err(ErrorCode.USER_NOT_IN_PROJECT);
        return ok({ ...existingRow, roleName } as any);
      }

      return ok({ ...inserted, roleName } as any);
    });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to update project user role',
      context: { projectId, userId, roleId },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
