import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { ROLES } from '@/lib/roles';
import { ErrorCode } from '@/lib/types';

import * as repo from './project-users.repository';

// ── PGlite bootstrap ────────────────────────────────────────────────────────
const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Shared fixtures ──────────────────────────────────────────────────────────
let orgId: number;
let projectId: number;
let otherProjectId: number;
let projectUnitId: number;

// User pinned to projectId
let pinnedUserId: number;
// User with only an org-level grant (unpinned)
let unpinnedUserId: number;
// User pinned to otherProjectId (not to projectId)
let elsewhereUserId: number;

// Role IDs populated after schema + roles seed
let pmRoleId: number;
let ptRoleId: number;
let poRoleId: number;

let bibleId: number;
let bookId: number;

describe('project-users repository (PGlite integration)', () => {
  beforeAll(async () => {
    // ── Schema ────────────────────────────────────────────────────────────
    await createTestSchema(client, schema);

    // ── Seed: org + lang ──────────────────────────────────────────────────
    const [org] = await database
      .insert(schema.organizations)
      .values({ name: 'Test Org' })
      .returning();
    orgId = org.id;

    const [lang] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();

    // ── Seed: bible + book ────────────────────────────────────────────────
    const [bible] = await database
      .insert(schema.bibles)
      .values({
        name: 'Test Bible',
        abbreviation: 'TB',
        languageId: lang.id,
      })
      .returning();
    bibleId = bible.id;

    const [book] = await database
      .insert(schema.books)
      .values({
        code: 'GEN',
        eng_display_name: 'Genesis',
      })
      .returning();
    bookId = book.id;

    // ── Seed: roles ───────────────────────────────────────────────────────
    const [pmRole, ptRole, poRole, omRole, memberRole] = await database
      .insert(schema.roles)
      .values([
        { name: ROLES.PROJECT_MANAGER },
        { name: ROLES.PROJECT_TRANSLATOR },
        { name: ROLES.PROJECT_OBSERVER },
        { name: ROLES.ORG_MANAGER },
        { name: ROLES.ORG_MEMBER },
      ])
      .returning();
    pmRoleId = pmRole.id;
    ptRoleId = ptRole.id;
    poRoleId = poRole.id;

    // ── Seed: projects ────────────────────────────────────────────────────
    const [project] = await database
      .insert(schema.projects)
      .values({
        name: 'Target Project',
        organization: orgId,
        sourceLanguage: lang.id,
        targetLanguage: lang.id,
      })
      .returning();
    projectId = project.id;

    const [otherProject] = await database
      .insert(schema.projects)
      .values({
        name: 'Other Project',
        organization: orgId,
        sourceLanguage: lang.id,
        targetLanguage: lang.id,
      })
      .returning();
    otherProjectId = otherProject.id;

    const [unit] = await database.insert(schema.project_units).values({ projectId }).returning();
    projectUnitId = unit.id;

    await database.insert(schema.project_unit_bible_books).values({
      projectUnitId,
      bibleId,
      bookId,
    });

    // ── Seed: users ───────────────────────────────────────────────────────
    const [pinned] = await database
      .insert(schema.users)
      .values({ username: 'pinned_user', email: 'pinned@example.com' })
      .returning();
    pinnedUserId = pinned.id;

    const [unpinned] = await database
      .insert(schema.users)
      .values({ username: 'unpinned_user', email: 'unpinned@example.com' })
      .returning();
    unpinnedUserId = unpinned.id;

    const [elsewhere] = await database
      .insert(schema.users)
      .values({ username: 'elsewhere_user', email: 'elsewhere@example.com' })
      .returning();
    elsewhereUserId = elsewhere.id;

    // ── Seed: grants ──────────────────────────────────────────────────────
    // pinnedUserId  → project-pinned Translator on projectId
    await database.insert(schema.user_roles).values({
      userId: pinnedUserId,
      orgId,
      projectId,
      roleId: ptRoleId,
    });

    // unpinnedUserId → org-level Org Manager (no projectId)
    await database.insert(schema.user_roles).values({
      userId: unpinnedUserId,
      orgId,
      projectId: null,
      roleId: omRole.id,
    });

    // elsewhereUserId → project-pinned Translator on the OTHER project only
    await database.insert(schema.user_roles).values({
      userId: elsewhereUserId,
      orgId,
      projectId: otherProjectId,
      roleId: ptRoleId,
    });

    // Org Member anchor rows for pinned and elsewhere users (zero-permission anchors)
    await database.insert(schema.user_roles).values([
      { userId: pinnedUserId, orgId, projectId: null, roleId: memberRole.id },
      { userId: elsewhereUserId, orgId, projectId: null, roleId: memberRole.id },
    ]);
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  // ── getProjectUsers ────────────────────────────────────────────────────────
  describe('getProjectUsers', () => {
    it('includes only the user pinned to the target project', async () => {
      const result = await repo.getProjectUsers(projectId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const userIds = result.data.map((u) => u.userId);
      expect(userIds).toContain(pinnedUserId);
    });

    it('excludes the unpinned org-level user (Org Manager with no projectId grant)', async () => {
      const result = await repo.getProjectUsers(projectId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const userIds = result.data.map((u) => u.userId);
      expect(userIds).not.toContain(unpinnedUserId);
    });

    it('excludes the user pinned to a different project', async () => {
      const result = await repo.getProjectUsers(projectId);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const userIds = result.data.map((u) => u.userId);
      expect(userIds).not.toContain(elsewhereUserId);
    });

    it('returns PROJECT_NOT_FOUND for an unknown project', async () => {
      const result = await repo.getProjectUsers(99999);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.PROJECT_NOT_FOUND);
    });
  });

  // ── updateProjectUserRole ──────────────────────────────────────────────────
  describe('updateProjectUserRole', () => {
    it('returns USER_NOT_IN_PROJECT and writes nothing for the unpinned org-level user', async () => {
      const before = await database
        .select()
        .from(schema.user_roles)
        .where(
          and(
            eq(schema.user_roles.userId, unpinnedUserId),
            eq(schema.user_roles.projectId, projectId)
          )
        );

      const result = await repo.updateProjectUserRole(
        projectId,
        unpinnedUserId,
        pmRoleId,
        ROLES.PROJECT_MANAGER
      );

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_PROJECT);

      // No project-pinned row was created
      const after = await database
        .select()
        .from(schema.user_roles)
        .where(
          and(
            eq(schema.user_roles.userId, unpinnedUserId),
            eq(schema.user_roles.projectId, projectId)
          )
        );
      expect(after).toHaveLength(before.length);
    });

    it('updates role for the pinned user and returns the new record', async () => {
      const result = await repo.updateProjectUserRole(
        projectId,
        pinnedUserId,
        pmRoleId,
        ROLES.PROJECT_MANAGER
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.data.roleId).toBe(pmRoleId);
      expect(result.data.roleName).toBe(ROLES.PROJECT_MANAGER);

      // Restore to Translator so later tests start from a known state
      await repo.updateProjectUserRole(projectId, pinnedUserId, ptRoleId, ROLES.PROJECT_TRANSLATOR);
    });

    it('clears chapter assignments when updating to Observer role', async () => {
      // Assign a chapter to pinnedUser on projectId
      const [assignment] = await database
        .insert(schema.chapter_assignments)
        .values({
          projectUnitId,
          bibleId,
          bookId,
          chapterNumber: 1,
          status: 'draft',
          assignedUserId: pinnedUserId,
          isAiEnabled: false,
        })
        .returning();

      const result = await repo.updateProjectUserRole(
        projectId,
        pinnedUserId,
        poRoleId,
        ROLES.PROJECT_OBSERVER
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.roleId).toBe(poRoleId);

      // After role change to Observer, the drafter assignment should be cleared
      const [updated] = await database
        .select({ assignedUserId: schema.chapter_assignments.assignedUserId })
        .from(schema.chapter_assignments)
        .where(eq(schema.chapter_assignments.id, assignment.id));

      expect(updated.assignedUserId).toBeNull();

      // Clean up — restore role
      await repo.updateProjectUserRole(projectId, pinnedUserId, ptRoleId, ROLES.PROJECT_TRANSLATOR);
    });
  });

  // ── removeProjectUser ──────────────────────────────────────────────────────
  describe('removeProjectUser', () => {
    it('returns USER_NOT_IN_PROJECT for the unpinned org-level user', async () => {
      const result = await repo.removeProjectUser(projectId, unpinnedUserId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_PROJECT);
    });

    it('preserves the elsewhere-project grant when removing from target project', async () => {
      // elsewhereUserId has no pin on projectId, so removal must fail (no row to delete)
      const result = await repo.removeProjectUser(projectId, elsewhereUserId);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe(ErrorCode.USER_NOT_IN_PROJECT);

      // Their grant on otherProjectId must still be intact
      const [grant] = await database
        .select()
        .from(schema.user_roles)
        .where(
          and(
            eq(schema.user_roles.userId, elsewhereUserId),
            eq(schema.user_roles.projectId, otherProjectId)
          )
        );
      expect(grant).toBeDefined();
    });

    it('removes the pinned user grant and returns ok', async () => {
      // Add a temporary user to remove so pinnedUserId tests above stay consistent
      const [tempUser] = await database
        .insert(schema.users)
        .values({ username: 'temp_user', email: 'temp@example.com' })
        .returning();

      await database.insert(schema.user_roles).values({
        userId: tempUser.id,
        orgId,
        projectId,
        roleId: ptRoleId,
      });

      const result = await repo.removeProjectUser(projectId, tempUser.id);
      expect(result.ok).toBe(true);

      // Row is gone
      const rows = await database
        .select()
        .from(schema.user_roles)
        .where(
          and(eq(schema.user_roles.userId, tempUser.id), eq(schema.user_roles.projectId, projectId))
        );
      expect(rows).toHaveLength(0);

      // Both unrelated grants remain preserved
      const [unpinnedGrant] = await database
        .select()
        .from(schema.user_roles)
        .where(eq(schema.user_roles.userId, unpinnedUserId));
      expect(unpinnedGrant).toBeDefined();

      const [elsewhereGrant] = await database
        .select()
        .from(schema.user_roles)
        .where(eq(schema.user_roles.userId, elsewhereUserId));
      expect(elsewhereGrant).toBeDefined();
    });
  });
});
