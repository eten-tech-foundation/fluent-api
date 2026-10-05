import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '@/db';
import {
  bible_books,
  bibles,
  books,
  chapter_assignment_assigned_user_history,
  chapter_assignment_status_history,
  chapter_assignments,
  languages,
  organizations,
  pericope_sets,
  project_unit_bible_books,
  project_units,
  projects,
  roles,
  user_roles,
} from '@/db/schema';

import type { GrantPlan } from './grants';
import type { DemoProject, DemoSpec, DemoUser } from './types';

import { reconcileSeedUser } from '../dev-users';
import { buildGrantPlan, isStaleProjectRoleGrant } from './grants';

/**
 * `seedDemoSpec` — interprets a declarative DemoSpec into seeded rows.
 *
 * Every stage reconciles rather than assumes a blank DB: create-if-missing,
 * update drifted fields, never duplicate. Ordering matters — later stages
 * resolve keys registered by earlier ones:
 *
 *   languages → orgs → bibles → users (+org-scoped & global grants)
 *   → projects → milestones → book links → chapter assignments
 *   → project-scoped grants → stale-grant cleanup
 */

interface Ctx {
  spec: DemoSpec;
  /** Desired grants, built once — user/org/project keys, resolved to ids per stage. */
  grantPlan: GrantPlan[];
  orgs: Map<string, number>; // org key → organizations.id
  users: Map<string, number>; // user key → users.id
  projects: Map<string, number>; // project key → projects.id
  milestones: Map<string, number>; // `${projectKey}/${milestoneKey}` → project_units.id
  languages: Map<string, number>; // iso639-3 → languages.id
  bibles: Map<string, number>; // abbreviation → bibles.id
  books: Map<string, number>; // code → books.id
  pericopeSets: Map<string, number>; // name → pericope_sets.id
  roles: Map<string, number>; // name → roles.id
}

// ─── Actor resolution ────────────────────────────────────────────────────────
// `createdBy` should name the realistic creating actor: the org's Org Manager
// where one exists, else the global user (SuperAdmin), else the first spec
// user. Users created *before* their actor exists get null (self/first).

function orgManagerKey(spec: DemoSpec, orgKey: string): string | undefined {
  return spec.users.find((u) =>
    u.orgs?.some((o) => o.org === orgKey && o.roles.includes('Org Manager'))
  )?.key;
}

function globalActorKey(spec: DemoSpec): string | undefined {
  return spec.users.find((u) => u.globalRoles?.length)?.key;
}

function actorKeyFor(spec: DemoSpec, user: DemoUser): string | null {
  const firstOrg = user.orgs?.[0]?.org;
  const candidates = [
    firstOrg ? orgManagerKey(spec, firstOrg) : undefined,
    globalActorKey(spec),
    spec.users[0]?.key,
  ];
  // A user can't be their own creator — fall through to the next candidate.
  return candidates.find((key): key is string => key !== undefined && key !== user.key) ?? null;
}

/** Seed order: global actors first, then org managers, then everyone else —
 *  so every user's `createdBy` target already exists when they are written. */
function orderedUsers(spec: DemoSpec): DemoUser[] {
  const isGlobal = (u: DemoUser) => (u.globalRoles?.length ?? 0) > 0;
  const isOrgManager = (u: DemoUser) =>
    u.orgs?.some((o) => o.roles.includes('Org Manager')) ?? false;
  return [
    ...spec.users.filter(isGlobal),
    ...spec.users.filter((u) => !isGlobal(u) && isOrgManager(u)),
    ...spec.users.filter((u) => !isGlobal(u) && !isOrgManager(u)),
  ];
}

// ─── Stage 1: languages ─────────────────────────────────────────────────────

async function seedSpecLanguages(ctx: Ctx) {
  for (const lang of ctx.spec.languages ?? []) {
    const [existing] = await db
      .select({ id: languages.id })
      .from(languages)
      .where(eq(languages.langCodeIso6393, lang.code))
      .limit(1);
    if (!existing) {
      await db.insert(languages).values({
        langName: lang.name,
        langNameLocalized: lang.localizedName ?? null,
        langCodeIso6393: lang.code,
      });
      console.log(`  language ${lang.code} (${lang.name})`);
    }
  }

  // Resolve every language code the spec references (spec rows + reference data).
  const codes = new Set<string>();
  for (const p of ctx.spec.projects) {
    codes.add(p.sourceLanguage);
    codes.add(p.targetLanguage);
  }
  for (const b of ctx.spec.bibles ?? []) codes.add(b.language);
  for (const l of ctx.spec.languages ?? []) codes.add(l.code);

  const rows = await db
    .select({ id: languages.id, code: languages.langCodeIso6393 })
    .from(languages)
    .where(inArray(languages.langCodeIso6393, [...codes]));
  for (const r of rows) {
    if (r.code) ctx.languages.set(r.code, r.id);
  }
  const missing = [...codes].filter((c) => !ctx.languages.has(c));
  if (missing.length) {
    throw new Error(`Unknown language codes: ${missing.join(', ')} — not in spec or reference data`);
  }
}

// ─── Stage 2: organizations ─────────────────────────────────────────────────

async function seedSpecOrganizations(ctx: Ctx) {
  for (const org of ctx.spec.organizations) {
    const [existing] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, org.name))
      .limit(1);
    if (existing) {
      ctx.orgs.set(org.key, existing.id);
    } else {
      const [row] = await db
        .insert(organizations)
        .values({ name: org.name })
        .returning({ id: organizations.id });
      ctx.orgs.set(org.key, row.id);
      console.log(`  org ${org.name}`);
    }
  }
}

// ─── Stage 3: bibles + book links ───────────────────────────────────────────

async function seedSpecBibles(ctx: Ctx) {
  // Books used anywhere in the spec — resolve codes once.
  const codes = new Set<string>();
  for (const b of ctx.spec.bibles ?? []) for (const c of b.books ?? []) codes.add(c);
  for (const p of ctx.spec.projects)
    for (const m of p.milestones) for (const bk of m.books) codes.add(bk.code);

  if (codes.size) {
    const rows = await db
      .select({ id: books.id, code: books.code })
      .from(books)
      .where(inArray(books.code, [...codes]));
    for (const r of rows) ctx.books.set(r.code, r.id);
    const missing = [...codes].filter((c) => !ctx.books.has(c));
    if (missing.length) {
      throw new Error(`Unknown book codes: ${missing.join(', ')} — run db:seed:books first`);
    }
  }

  for (const spec of ctx.spec.bibles ?? []) {
    const languageId = ctx.languages.get(spec.language)!;
    let [bible] = await db
      .select({ id: bibles.id, hasAudio: bibles.hasAudio })
      .from(bibles)
      .where(eq(bibles.abbreviation, spec.abbreviation))
      .limit(1);
    if (!bible) {
      [bible] = await db
        .insert(bibles)
        .values({
          abbreviation: spec.abbreviation,
          name: spec.name,
          languageId,
          hasAudio: spec.hasAudio ?? false,
        })
        .returning({ id: bibles.id, hasAudio: bibles.hasAudio });
      console.log(`  bible ${spec.abbreviation}`);
    }
    ctx.bibles.set(spec.abbreviation, bible.id);

    // Link books — dedupe existing links like seeds/bibles.ts does.
    const linked = await db
      .select({ bookId: bible_books.bookId })
      .from(bible_books)
      .where(eq(bible_books.bibleId, bible.id));
    const linkedIds = new Set(linked.map((l) => l.bookId));
    const toInsert = (spec.books ?? [])
      .map((code) => ctx.books.get(code)!)
      .filter((id) => !linkedIds.has(id))
      .map((bookId) => ({ bibleId: bible.id, bookId }));
    if (toInsert.length) await db.insert(bible_books).values(toInsert);
  }

  // Resolve bible abbreviations referenced by projects (may be reference data).
  const abbrevs = new Set<string>([
    ...(ctx.spec.bibles ?? []).map((b) => b.abbreviation),
    ...ctx.spec.projects.map((p) => p.sourceBible),
  ]);
  const rows = await db
    .select({ id: bibles.id, abbreviation: bibles.abbreviation })
    .from(bibles)
    .where(inArray(bibles.abbreviation, [...abbrevs]));
  for (const r of rows) ctx.bibles.set(r.abbreviation, r.id);
  const missing = [...abbrevs].filter((a) => !ctx.bibles.has(a));
  if (missing.length) {
    throw new Error(`Unknown bibles: ${missing.join(', ')} — not in spec or reference data`);
  }
}

// ─── Stage 4: users + org-scoped & global grants ────────────────────────────

async function seedSpecUsers(ctx: Ctx) {
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

    // Org-scoped + global grants now; project-scoped grants wait for stage 8.
    const grantedBy = (actorKey ? ctx.users.get(actorKey) : undefined) ?? appUserId;
    const userGrants = ctx.grantPlan.filter(
      (g) => g.userKey === user.key && g.projectKey === null
    );
    await applyGrants(ctx, appUserId, userGrants, grantedBy);
  }
}

async function applyGrants(
  ctx: Ctx,
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

// ─── Stage 5: projects ──────────────────────────────────────────────────────

async function seedSpecProjects(ctx: Ctx) {
  const pmKeyFor = (project: DemoProject) =>
    ctx.spec.users.find((u) =>
      u.projectRoles?.some((r) => r.project === project.key && r.role === 'Project Manager')
    )?.key;

  for (const project of ctx.spec.projects) {
    const orgId = ctx.orgs.get(project.org);
    if (!orgId) throw new Error(`Project "${project.key}" references unknown org "${project.org}"`);
    const sourceLanguage = ctx.languages.get(project.sourceLanguage)!;
    const targetLanguage = ctx.languages.get(project.targetLanguage)!;
    const sourceBibleId = ctx.bibles.get(project.sourceBible);
    if (!sourceBibleId) {
      throw new Error(`Project "${project.key}" references unknown bible "${project.sourceBible}"`);
    }

    let pericopeSetId: number | null = null;
    if (project.pericopeSet) {
      if (!ctx.pericopeSets.size) {
        const rows = await db.select({ id: pericope_sets.id, name: pericope_sets.name }).from(pericope_sets);
        for (const r of rows) ctx.pericopeSets.set(r.name, r.id);
      }
      pericopeSetId = ctx.pericopeSets.get(project.pericopeSet) ?? null;
      if (!pericopeSetId) {
        throw new Error(`Project "${project.key}" references unknown pericope set "${project.pericopeSet}" — run db:seed:pericope-sets first`);
      }
    }

    const creatorKey = pmKeyFor(project) ?? orgManagerKey(ctx.spec, project.org) ?? globalActorKey(ctx.spec);
    const createdBy = creatorKey ? (ctx.users.get(creatorKey) ?? null) : null;

    const [existing] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.name, project.name), eq(projects.organization, orgId)))
      .limit(1);

    if (!existing) {
      const [row] = await db
        .insert(projects)
        .values({
          name: project.name,
          sourceLanguage,
          targetLanguage,
          organization: orgId,
          status: 'active',
          sourceBibleId,
          pericopeSetId,
          createdBy,
        })
        .returning({ id: projects.id });
      ctx.projects.set(project.key, row.id);
      console.log(`  project ${project.name}`);
      continue;
    }

    ctx.projects.set(project.key, existing.id);
    const drifted: Partial<typeof projects.$inferInsert> = {};
    if (existing.sourceBibleId !== sourceBibleId) drifted.sourceBibleId = sourceBibleId;
    if (existing.pericopeSetId !== pericopeSetId) drifted.pericopeSetId = pericopeSetId;
    if (existing.status !== 'active') drifted.status = 'active';
    if (existing.sourceLanguage !== sourceLanguage) drifted.sourceLanguage = sourceLanguage;
    if (existing.targetLanguage !== targetLanguage) drifted.targetLanguage = targetLanguage;
    if (Object.keys(drifted).length) {
      await db.update(projects).set(drifted).where(eq(projects.id, existing.id));
      console.log(`  project ${project.name} reconciled`);
    }
  }
}

// ─── Stage 6: milestones ────────────────────────────────────────────────────

async function seedSpecMilestones(ctx: Ctx) {
  for (const project of ctx.spec.projects) {
    const projectId = ctx.projects.get(project.key)!;
    for (const milestone of project.milestones) {
      const [existing] = await db
        .select()
        .from(project_units)
        .where(and(eq(project_units.projectId, projectId), eq(project_units.name, milestone.name)))
        .limit(1);

      const want = {
        type: milestone.type ?? 'text',
        status: milestone.status ?? 'in_progress',
        connectivityProfile: milestone.connectivityProfile ?? null,
      };

      if (!existing) {
        const [row] = await db
          .insert(project_units)
          .values({ projectId, name: milestone.name, ...want })
          .returning({ id: project_units.id });
        ctx.milestones.set(`${project.key}/${milestone.key}`, row.id);
        console.log(`  milestone ${milestone.name} (${project.name})`);
        continue;
      }

      ctx.milestones.set(`${project.key}/${milestone.key}`, existing.id);
      const drifted: Partial<typeof project_units.$inferInsert> = {};
      if (existing.type !== want.type) drifted.type = want.type;
      if (existing.status !== want.status) drifted.status = want.status;
      if (existing.connectivityProfile !== want.connectivityProfile) {
        drifted.connectivityProfile = want.connectivityProfile;
      }
      if (Object.keys(drifted).length) {
        await db.update(project_units).set(drifted).where(eq(project_units.id, existing.id));
      }
    }
  }
}

// ─── Stage 7: book links (deletedAt-aware) ──────────────────────────────────

async function seedSpecBookLinks(ctx: Ctx) {
  for (const project of ctx.spec.projects) {
    const bibleId = ctx.bibles.get(project.sourceBible)!;
    for (const milestone of project.milestones) {
      const unitId = ctx.milestones.get(`${project.key}/${milestone.key}`)!;
      for (const book of milestone.books) {
        const bookId = ctx.books.get(book.code)!;
        const [link] = await db
          .select()
          .from(project_unit_bible_books)
          .where(
            and(
              eq(project_unit_bible_books.projectUnitId, unitId),
              eq(project_unit_bible_books.bookId, bookId)
            )
          )
          .limit(1);

        if (!link) {
          await db.insert(project_unit_bible_books).values({ projectUnitId: unitId, bibleId, bookId });
        } else if (link.deletedAt || link.bibleId !== bibleId) {
          // Restore soft-deleted links rather than inserting a duplicate —
          // mirrors createMilestone's move-back semantics — and reconcile a
          // drifted bibleId on live rows too.
          await db
            .update(project_unit_bible_books)
            .set({ deletedAt: null, bibleId })
            .where(
              and(
                eq(project_unit_bible_books.projectUnitId, unitId),
                eq(project_unit_bible_books.bookId, bookId)
              )
            );
          console.log(`  reconciled book link ${book.code} → ${milestone.name}`);
        }
      }
    }
  }
}

// ─── Stage 8: chapter assignments (+ status history) ────────────────────────
// Direct inserts: the app's createChapterAssignmentForProjectUnit discovers
// chapters from bible_texts, which demo bibles may not have — the spec's
// chapter list is authoritative here.

async function seedSpecChapterAssignments(ctx: Ctx) {
  for (const project of ctx.spec.projects) {
    const bibleId = ctx.bibles.get(project.sourceBible)!;
    for (const milestone of project.milestones) {
      const unitId = ctx.milestones.get(`${project.key}/${milestone.key}`)!;
      for (const book of milestone.books) {
        const bookId = ctx.books.get(book.code)!;
        const existing = await db
          .select()
          .from(chapter_assignments)
          .where(
            and(
              eq(chapter_assignments.projectUnitId, unitId),
              eq(chapter_assignments.bibleId, bibleId),
              eq(chapter_assignments.bookId, bookId)
            )
          );
        const byChapter = new Map(existing.map((a) => [a.chapterNumber, a]));

        for (const ch of book.chapters) {
          const assignedUserId = ch.assignedTo ? ctx.users.get(ch.assignedTo) : null;
          if (ch.assignedTo && !assignedUserId) {
            throw new Error(`Chapter ${book.code} ${ch.number} assigned to unknown user "${ch.assignedTo}"`);
          }
          const peerCheckerId = ch.peerChecker ? ctx.users.get(ch.peerChecker) : null;
          if (ch.peerChecker && !peerCheckerId) {
            throw new Error(`Chapter ${book.code} ${ch.number} peer-checked by unknown user "${ch.peerChecker}"`);
          }

          const row = byChapter.get(ch.number);
          if (!row) {
            const [inserted] = await db
              .insert(chapter_assignments)
              .values({
                projectUnitId: unitId,
                bibleId,
                bookId,
                chapterNumber: ch.number,
                status: ch.status,
                assignedUserId: assignedUserId ?? null,
                peerCheckerId: peerCheckerId ?? null,
                isAiEnabled: ch.isAiEnabled ?? false,
              })
              .returning({ id: chapter_assignments.id });
            // Mirror the service's initial-history writes so history views
            // aren't empty for seeded rows.
            await db.insert(chapter_assignment_status_history).values({
              chapterAssignmentId: inserted.id,
              status: ch.status,
            });
            const assignmentHistory = [
              { userId: assignedUserId, role: 'drafter' as const },
              { userId: peerCheckerId, role: 'peer_checker' as const },
            ].filter((h): h is { userId: number; role: 'drafter' | 'peer_checker' } => h.userId != null);
            if (assignmentHistory.length) {
              await db.insert(chapter_assignment_assigned_user_history).values(
                assignmentHistory.map((h) => ({
                  chapterAssignmentId: inserted.id,
                  assignedUserId: h.userId,
                  role: h.role,
                  status: ch.status,
                }))
              );
            }
          } else {
            const drifted: Partial<typeof chapter_assignments.$inferInsert> = {};
            if (row.status !== ch.status) drifted.status = ch.status;
            if (row.assignedUserId !== (assignedUserId ?? null)) {
              drifted.assignedUserId = assignedUserId ?? null;
            }
            if (row.peerCheckerId !== (peerCheckerId ?? null)) {
              drifted.peerCheckerId = peerCheckerId ?? null;
            }
            if (row.isAiEnabled !== (ch.isAiEnabled ?? false)) {
              drifted.isAiEnabled = ch.isAiEnabled ?? false;
            }
            if (Object.keys(drifted).length) {
              await db.update(chapter_assignments).set(drifted).where(eq(chapter_assignments.id, row.id));
              const effectiveStatus = drifted.status ?? row.status;
              if (drifted.status) {
                await db.insert(chapter_assignment_status_history).values({
                  chapterAssignmentId: row.id,
                  status: drifted.status,
                });
              }
              const reassigned = [
                { userId: drifted.assignedUserId, role: 'drafter' as const },
                { userId: drifted.peerCheckerId, role: 'peer_checker' as const },
              ].filter((h): h is { userId: number; role: 'drafter' | 'peer_checker' } => h.userId != null);
              if (reassigned.length) {
                await db.insert(chapter_assignment_assigned_user_history).values(
                  reassigned.map((h) => ({
                    chapterAssignmentId: row.id,
                    assignedUserId: h.userId,
                    role: h.role,
                    status: effectiveStatus,
                  }))
                );
              }
            }
          }
        }
      }
    }
  }
}

// ─── Stage 9: project-scoped grants ─────────────────────────────────────────

async function seedProjectGrants(ctx: Ctx) {
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

async function cleanupStaleGrants(ctx: Ctx) {
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

// ─── Entry point ────────────────────────────────────────────────────────────

export async function seedDemoSpec(spec: DemoSpec): Promise<void> {
  const allRoles = await db.select({ id: roles.id, name: roles.name }).from(roles);
  const ctx: Ctx = {
    spec,
    grantPlan: buildGrantPlan(spec),
    orgs: new Map(),
    users: new Map(),
    projects: new Map(),
    milestones: new Map(),
    languages: new Map(),
    bibles: new Map(),
    books: new Map(),
    pericopeSets: new Map(),
    roles: new Map(allRoles.map((r) => [r.name, r.id])),
  };

  console.log('  languages & orgs...');
  await seedSpecLanguages(ctx);
  await seedSpecOrganizations(ctx);
  console.log('  bibles & book links...');
  await seedSpecBibles(ctx);
  console.log('  users & org/global grants...');
  await seedSpecUsers(ctx);
  console.log('  projects...');
  await seedSpecProjects(ctx);
  console.log('  milestones...');
  await seedSpecMilestones(ctx);
  console.log('  project book links...');
  await seedSpecBookLinks(ctx);
  console.log('  chapter assignments...');
  await seedSpecChapterAssignments(ctx);
  console.log('  project-scoped grants...');
  await seedProjectGrants(ctx);
  await cleanupStaleGrants(ctx);
  console.log('Demo spec seeded.');
}
