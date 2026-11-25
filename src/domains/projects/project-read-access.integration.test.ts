import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { seedRbac } from '@/db/seeds/rbac';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { ROLES } from '@/lib/roles';
import { server } from '@/server/server';
import { signInAs } from '@/test/utils/session';
import '@/domains/projects/projects.route';
import '@/domains/usfm/usfm.route';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

// Only the session lookup and the logger are replaced. Users, grants, projects and
// project membership come from real queries, so the policies see real rows.
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

interface Person {
  id: number;
  email: string;
  username: string;
}

let assignedProjectId: number;
let otherProjectId: number;
let assignedUnitId: number;
let otherUnitId: number;

// Project Translator on assignedProjectId, plus the Org Member anchor every invitee gets.
let translator: Person;
// Org Manager of the organization that owns both projects.
let orgManager: Person;
// Only the zero-permission Org Member anchor.
let anchorOnly: Person;
// Org Manager of another organization, holding a row that names assignedProjectId under
// that other organization's id.
let otherOrgManager: Person;

async function roleId(name: string): Promise<number> {
  const [row] = await database
    .select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, name));
  return row.id;
}

async function insertPerson(username: string): Promise<Person> {
  const [row] = await database
    .insert(schema.users)
    .values({ username, email: `${username}@example.com`, status: 'verified' })
    .returning();
  return { id: row.id, email: row.email, username: row.username };
}

describe('project read access with real grants', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);

    const [org] = await database
      .insert(schema.organizations)
      .values({ name: 'Owning org' })
      .returning();
    const [otherOrg] = await database
      .insert(schema.organizations)
      .values({ name: 'Other org' })
      .returning();
    const [lang] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();

    await database.insert(schema.roles).values(Object.values(ROLES).map((name) => ({ name })));
    await seedRbac();

    const [assigned, other] = await database
      .insert(schema.projects)
      .values([
        {
          name: 'Assigned project',
          organization: org.id,
          sourceLanguage: lang.id,
          targetLanguage: lang.id,
        },
        {
          name: 'Other project',
          organization: org.id,
          sourceLanguage: lang.id,
          targetLanguage: lang.id,
        },
      ])
      .returning();
    assignedProjectId = assigned.id;
    otherProjectId = other.id;

    const [assignedUnit, otherUnit] = await database
      .insert(schema.project_units)
      .values([
        { projectId: assignedProjectId, name: 'Assigned milestone' },
        { projectId: otherProjectId, name: 'Other milestone' },
      ])
      .returning();
    assignedUnitId = assignedUnit.id;
    otherUnitId = otherUnit.id;

    translator = await insertPerson('translator');
    orgManager = await insertPerson('org_manager');
    anchorOnly = await insertPerson('anchor_only');
    otherOrgManager = await insertPerson('other_org_manager');

    const orgMemberRole = await roleId(ROLES.ORG_MEMBER);
    await database.insert(schema.user_roles).values([
      { userId: translator.id, orgId: org.id, projectId: null, roleId: orgMemberRole },
      {
        userId: translator.id,
        orgId: org.id,
        projectId: assignedProjectId,
        roleId: await roleId(ROLES.PROJECT_TRANSLATOR),
      },
      { userId: orgManager.id, orgId: org.id, projectId: null, roleId: orgMemberRole },
      {
        userId: orgManager.id,
        orgId: org.id,
        projectId: null,
        roleId: await roleId(ROLES.ORG_MANAGER),
      },
      { userId: anchorOnly.id, orgId: org.id, projectId: null, roleId: orgMemberRole },
      {
        userId: otherOrgManager.id,
        orgId: otherOrg.id,
        projectId: null,
        roleId: await roleId(ROLES.ORG_MANAGER),
      },
      {
        userId: otherOrgManager.id,
        orgId: otherOrg.id,
        projectId: assignedProjectId,
        roleId: await roleId(ROLES.PROJECT_MANAGER),
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  describe('GET /projects/{id}', () => {
    it('returns the project to a translator assigned to it', async () => {
      signInAs(translator);
      const res = await server.request(`/projects/${assignedProjectId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: assignedProjectId, name: 'Assigned project' });
    });

    it('hides another project of the same organization from that translator', async () => {
      signInAs(translator);
      const res = await server.request(`/projects/${otherProjectId}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
    });

    it('returns any project of the organization to its Org Manager', async () => {
      signInAs(orgManager);
      const res = await server.request(`/projects/${otherProjectId}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: otherProjectId });
    });

    it("ignores a role row that names the project under another organization's id", async () => {
      signInAs(otherOrgManager);
      const res = await server.request(`/projects/${assignedProjectId}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
    });
  });

  describe('exporting USFM', () => {
    it('lists exportable books to a translator assigned to the project', async () => {
      signInAs(translator);
      const res = await server.request(`/project-units/${assignedUnitId}/usfm/books`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        projectUnitId: assignedUnitId,
        books: [],
        totalBooks: 0,
      });
    });

    it('hides a project the translator is not assigned to', async () => {
      signInAs(translator);
      const res = await server.request(`/project-units/${otherUnitId}/usfm/books`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
    });

    it('refuses the export to someone who only holds the Org Member anchor', async () => {
      signInAs(anchorOnly);
      const res = await server.request(`/project-units/${assignedUnitId}/usfm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Project not found' });
    });
  });
});
