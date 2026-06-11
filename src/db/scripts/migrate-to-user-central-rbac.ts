/**
 * RBAC Data Migration Script — Run BETWEEN migration phases.
 *
 * Deployment order for each environment (dev → staging → prod):
 *   1. npm run db:migrate          → applies 0012 (creates user_roles table)
 *   2. npm run db:migrate-rbac     → THIS SCRIPT (ports data from legacy columns)
 *   3. npm run db:migrate          → applies 0013 (drops legacy columns + project_users)
 *
 * DO NOT run step 3 before step 2, or you will permanently lose role/org data.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { roles, user_roles, users } from '@/db/schema';
import { ROLES } from '@/lib/roles';

export async function migrateToUserCentralRbac(): Promise<void> {
  await db.transaction(async (tx) => {
    // 1. Rename legacy role rows so name FKs line up with the new constants.
    await tx.update(roles).set({ name: ROLES.PROJECT_MANAGER }).where(eq(roles.name, 'Manager'));
    await tx
      .update(roles)
      .set({ name: ROLES.PROJECT_TRANSLATOR })
      .where(eq(roles.name, 'Translator'));

    const roleRows = await tx.select({ id: roles.id, name: roles.name }).from(roles);
    const roleId = new Map(roleRows.map((r) => [r.name, r.id]));
    const pmId = roleId.get(ROLES.PROJECT_MANAGER);
    const ptId = roleId.get(ROLES.PROJECT_TRANSLATOR);

    if (!pmId || !ptId) {
      throw new Error('Required roles not found in DB after update');
    }

    const allUsers = await tx
      .select({
        id: users.id,
        organization: sql<number>`organization`,
        role: sql<number>`role`,
      })
      .from(users);

    for (const u of allUsers) {
      if (u.role === pmId) {
        // Manager -> org-wide PM grant
        await tx
          .insert(user_roles)
          .values({
            userId: u.id,
            orgId: u.organization,
            projectId: null,
            roleId: pmId,
            createdBy: u.id,
          })
          .onConflictDoNothing();
      } else if (u.role === ptId) {
        // Translator -> project-pinned PT grant per project_users row
        const memberships = await tx
          .select({ projectId: sql<number>`project_id` })
          .from(sql`project_users`)
          .where(eq(sql`user_id`, u.id));
        for (const m of memberships) {
          await tx
            .insert(user_roles)
            .values({
              userId: u.id,
              orgId: u.organization,
              projectId: m.projectId,
              roleId: ptId,
              createdBy: u.id,
            })
            .onConflictDoNothing();
        }
      }
    }

    // 3. Verify: no user who had active assignments or is a Manager is left without grants.
    const trueOrphans = [];

    for (const u of allUsers) {
      if (u.role === pmId) {
        const [hasExpected] = await tx
          .select({ id: user_roles.id })
          .from(user_roles)
          .where(
            and(
              eq(user_roles.userId, u.id),
              eq(user_roles.roleId, pmId),
              eq(user_roles.orgId, u.organization),
              isNull(user_roles.projectId)
            )
          )
          .limit(1);
        if (!hasExpected) {
          trueOrphans.push(u.id);
        }
      } else if (u.role === ptId) {
        const memberships = await tx
          .select({ projectId: sql<number>`project_id` })
          .from(sql`project_users`)
          .where(eq(sql`user_id`, u.id));

        for (const m of memberships) {
          const [hasExpected] = await tx
            .select({ id: user_roles.id })
            .from(user_roles)
            .where(
              and(
                eq(user_roles.userId, u.id),
                eq(user_roles.roleId, ptId),
                eq(user_roles.orgId, u.organization),
                eq(user_roles.projectId, m.projectId)
              )
            )
            .limit(1);
          if (!hasExpected) {
            trueOrphans.push(u.id);
            break;
          }
        }
      }
    }

    if (trueOrphans.length) {
      throw new Error(`Migration left active users without grants: ${trueOrphans.join(', ')}`);
    }
  });
  console.log('User-central RBAC migration complete.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateToUserCentralRbac()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}
