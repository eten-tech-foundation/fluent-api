import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { roles, user_roles } from '@/db/schema';

import type { DemoCtx } from './context';

import { reconcileSeedUser } from '../dev-users';
import { actorKeyFor, orderedUsers } from './actors';
import { isStaleProjectRoleGrant } from './grants';

// ─── Stage 4: users + org-scoped & global grants ────────────────────────────

export async function seedSpecUsers(ctx: DemoCtx) {
  for (const user of orderedUsers(ctx.spec)) {
    const actorKey = actorKeyFor(ctx.spec, user);
    const appUserId = await reconcileSeedUser({
      email: user.email,
      username: user.username,
      password: user.password,
      passwordHash: user.passwordHash ?? ctx.spec.passwordHash,
      firstName: user.firstName ?? user.username,
      lastName: user.lastName,
      createdBy: actorKey ? (ctx.users.get(actorKey) ?? null) : null,
    });
    if (appUserId === null) {
      console.log(`  skipped ${user.key} (${user.email})`);
      continue;
    }
    ctx.users.set(user.key, appUserId);

    // Org-scoped + global grants now; project-scoped grants wait for stage 9.
    const grantedBy = (actorKey ? ctx.users.get(actorKey) : undefined) ?? appUserId;
    const userGrants = ctx.grantPlan.filter((g) => g.userKey === user.key && g.projectKey === null);
    await applyGrants(ctx, appUserId, userGrants, grantedBy);
  }
}

async function applyGrants(
  ctx: DemoCtx,
  userId: number,
  grants: { roleName: string; orgKey: string | null; projectKey: string | null }[],
  grantedBy: number
) {
  if (!grants.length) return;
  const existing = await db
    .select({ orgId: user_roles.orgId, projectId: user_roles.projectId, roleId: user_roles.roleId })
    .from(user_roles)
    .where(eq(user_roles.userId, userId));
  const seen = new Set(existing.map((g) => `${g.orgId}|${g.projectId}|${g.roleId}`));

  for (const g of grants) {
    const roleId = ctx.roles.get(g.roleName);
    if (!roleId) throw new Error(`Role "${g.roleName}" not found — run seedRoles first`);
    const orgId = g.orgKey ? ctx.orgs.get(g.orgKey) : null;
    if (g.orgKey && orgId === undefined) {
      throw new Error(`Grant references unknown org "${g.orgKey}"`);
    }
    const projectId = g.projectKey ? ctx.projects.get(g.projectKey) : null;
    if (g.projectKey && projectId === undefined) {
      throw new Error(`Grant references unknown project "${g.projectKey}"`);
    }
    const sig = `${orgId}|${projectId}|${roleId}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    await db.insert(user_roles).values({
      userId,
      orgId: orgId ?? null,
      projectId: projectId ?? null,
      roleId,
      createdBy: grantedBy,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

// ─── Stage 9: project-scoped grants ─────────────────────────────────────────

export async function seedProjectGrants(ctx: DemoCtx) {
  for (const user of ctx.spec.users) {
    const userId = ctx.users.get(user.key);
    if (!userId) continue;
    const grants = ctx.grantPlan.filter((g) => g.userKey === user.key && g.projectKey !== null);
    const actorKey = actorKeyFor(ctx.spec, user);
    const grantedBy = (actorKey ? ctx.users.get(actorKey) : undefined) ?? userId;
    await applyGrants(ctx, userId, grants, grantedBy);
  }
}

// ─── Stage 10: stale-grant cleanup ──────────────────────────────────────────
// Repairs rows left by the old seed pattern: a project-level role sitting at
// org scope (project_id IS NULL) is never correct for seed-managed users.

export async function cleanupStaleGrants(ctx: DemoCtx) {
  const userIds = [...ctx.users.values()];
  if (!userIds.length) return;

  // Fetch org-scoped grants for spec users, then apply the tested rule.
  const candidates = await db
    .select({ id: user_roles.id, roleName: roles.name })
    .from(user_roles)
    .innerJoin(roles, eq(user_roles.roleId, roles.id))
    .where(and(inArray(user_roles.userId, userIds), isNull(user_roles.projectId)));

  const staleIds = candidates
    .filter((r) => isStaleProjectRoleGrant({ roleName: r.roleName, projectKey: null }))
    .map((r) => r.id);
  if (!staleIds.length) return;

  const deleted = await db
    .delete(user_roles)
    .where(inArray(user_roles.id, staleIds))
    .returning({ id: user_roles.id });
  if (deleted.length) {
    console.log(`  removed ${deleted.length} stale org-scoped project-role grant(s)`);
  }
}
