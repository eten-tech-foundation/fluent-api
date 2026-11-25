import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { seedRbac } from '@/db/seeds/rbac';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { ROLES } from '@/lib/roles';
import { server } from '@/server/server';
import { signInAs } from '@/test/utils/session';
import '@/domains/users/users.route';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

// The session lookup, the magic link and the invite email are replaced; users, grants
// and projects come from real queries.
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn(), signInMagicLink: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/lib/services/notifications/mailgun.service', () => ({
  sendExistingUserOrgInviteEmail: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

interface Person {
  id: number;
  email: string;
  username: string;
}

let orgId: number;
let ownProjectId: number;
let otherOrgProjectId: number;
let orgManager: Person;

async function insertPerson(username: string): Promise<Person> {
  const [row] = await database
    .insert(schema.users)
    .values({ username, email: `${username}@example.com`, status: 'verified' })
    .returning();
  return { id: row.id, email: row.email, username: row.username };
}

function grantsOf(userId: number) {
  return database
    .select({ orgId: schema.user_roles.orgId, projectId: schema.user_roles.projectId })
    .from(schema.user_roles)
    .where(eq(schema.user_roles.userId, userId));
}

function post(path: string, body: object) {
  return server.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('inviting users onto a project', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);

    const [org] = await database
      .insert(schema.organizations)
      .values({ name: 'Inviting org' })
      .returning();
    const [otherOrg] = await database
      .insert(schema.organizations)
      .values({ name: 'Other org' })
      .returning();
    orgId = org.id;
    const [lang] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();

    await database.insert(schema.roles).values(Object.values(ROLES).map((name) => ({ name })));
    await seedRbac();

    const [ownProject, otherOrgProject] = await database
      .insert(schema.projects)
      .values([
        {
          name: 'Own project',
          organization: org.id,
          sourceLanguage: lang.id,
          targetLanguage: lang.id,
        },
        {
          name: 'Other org project',
          organization: otherOrg.id,
          sourceLanguage: lang.id,
          targetLanguage: lang.id,
        },
      ])
      .returning();
    ownProjectId = ownProject.id;
    otherOrgProjectId = otherOrgProject.id;

    orgManager = await insertPerson('org_manager');
    const [orgManagerRole] = await database
      .select({ id: schema.roles.id })
      .from(schema.roles)
      .where(eq(schema.roles.name, ROLES.ORG_MANAGER));
    await database
      .insert(schema.user_roles)
      .values({ userId: orgManager.id, orgId: org.id, projectId: null, roleId: orgManagerRole.id });
  }, 60_000);

  beforeEach(() => {
    vi.clearAllMocks();
    signInAs(orgManager);
  });

  afterAll(async () => {
    await client.close();
  });

  describe('POST /users/invite', () => {
    it('gives an existing user a role on a project of the same organization', async () => {
      const invitee = await insertPerson('same_org_invitee');

      const res = await post('/users/invite', {
        email: invitee.email,
        username: invitee.username,
        orgId,
        projectId: ownProjectId,
        roleName: ROLES.PROJECT_TRANSLATOR,
      });

      expect(res.status).toBe(200);
      expect(await grantsOf(invitee.id)).toEqual(
        expect.arrayContaining([
          { orgId, projectId: null },
          { orgId, projectId: ownProjectId },
        ])
      );
    });

    it('rejects a project of another organization and grants nothing', async () => {
      const invitee = await insertPerson('other_org_invitee');

      const res = await post('/users/invite', {
        email: invitee.email,
        username: invitee.username,
        orgId,
        projectId: otherOrgProjectId,
        roleName: ROLES.PROJECT_MANAGER,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
      expect(await grantsOf(invitee.id)).toEqual([]);
    });

    it('does not create an account for a project of another organization', async () => {
      const res = await post('/users/invite', {
        email: 'brand-new@example.com',
        username: 'brand_new',
        orgId,
        projectId: otherOrgProjectId,
        roleName: ROLES.PROJECT_TRANSLATOR,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
      const users = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, 'brand-new@example.com'));
      expect(users).toEqual([]);
      const authUsers = await database
        .select({ id: schema.authUser.id })
        .from(schema.authUser)
        .where(eq(schema.authUser.email, 'brand-new@example.com'));
      expect(authUsers).toEqual([]);
    });

    it('answers a project that does not exist the same way', async () => {
      const invitee = await insertPerson('missing_project_invitee');

      const res = await post('/users/invite', {
        email: invitee.email,
        username: invitee.username,
        orgId,
        projectId: 999_999,
        roleName: ROLES.PROJECT_TRANSLATOR,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
      expect(await grantsOf(invitee.id)).toEqual([]);
    });
  });

  describe('POST /users', () => {
    it('rejects a project of another organization and creates no user', async () => {
      const res = await post('/users', {
        email: 'created-directly@example.com',
        username: 'created_directly',
        orgId,
        projectId: otherOrgProjectId,
        roleName: ROLES.PROJECT_TRANSLATOR,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
      const users = await database
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, 'created-directly@example.com'));
      expect(users).toEqual([]);
    });
  });
});
