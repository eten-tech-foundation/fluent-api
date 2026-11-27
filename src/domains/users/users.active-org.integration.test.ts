import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { err, ErrorCode, ok } from '@/lib/types';

import { setActiveOrg } from './users.service';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const CURRENT_SESSION = 'session-current';
const OTHER_SESSION = 'session-other-device';

describe('setActiveOrg (PGlite)', () => {
  let orgA: number;
  let orgB: number;
  let userId: number;
  let otherUserId: number;

  async function sessionActiveOrg(sessionId: string): Promise<number | null> {
    const [row] = await database
      .select({ activeOrgId: schema.authSession.activeOrgId })
      .from(schema.authSession)
      .where(eq(schema.authSession.id, sessionId));
    return row.activeOrgId;
  }

  async function userLastActiveOrg(id: number): Promise<number | null> {
    const [row] = await database
      .select({ lastActiveOrgId: schema.users.lastActiveOrgId })
      .from(schema.users)
      .where(eq(schema.users.id, id));
    return row.lastActiveOrgId;
  }

  beforeAll(async () => {
    await createTestSchema(client, {
      organizations: schema.organizations,
      authUser: schema.authUser,
      authSession: schema.authSession,
      users: schema.users,
      userStatusEnum: schema.userStatusEnum,
    });

    const [a, b] = await database
      .insert(schema.organizations)
      .values([{ name: 'Org A' }, { name: 'Org B' }])
      .returning();
    orgA = a.id;
    orgB = b.id;

    await database.insert(schema.authUser).values([
      { id: 'auth-ana', name: 'Ana', email: 'ana@example.com' },
      { id: 'auth-ben', name: 'Ben', email: 'ben@example.com' },
    ]);
    const [ana, ben] = await database
      .insert(schema.users)
      .values([
        { authUserId: 'auth-ana', username: 'ana', email: 'ana@example.com' },
        { authUserId: 'auth-ben', username: 'ben', email: 'ben@example.com' },
      ])
      .returning();
    userId = ana.id;
    otherUserId = ben.id;

    // Attached to one table at a time below to make that table's UPDATE fail.
    await client.exec(`
      CREATE FUNCTION fail_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'simulated % write failure', TG_TABLE_NAME;
      END;
      $$;
    `);
  });

  beforeEach(async () => {
    // Everyone starts in Org A. Ana is signed in on two devices.
    await database.delete(schema.authSession);
    await database.update(schema.users).set({ lastActiveOrgId: orgA });
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await database.insert(schema.authSession).values([
      {
        id: CURRENT_SESSION,
        token: 'token-current',
        userId: 'auth-ana',
        expiresAt,
        activeOrgId: orgA,
      },
      { id: OTHER_SESSION, token: 'token-other', userId: 'auth-ana', expiresAt, activeOrgId: orgA },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("sets the session's active org and the user's last active org", async () => {
    const result = await setActiveOrg(userId, CURRENT_SESSION, orgB);

    expect(result).toEqual(ok(undefined));
    expect(await sessionActiveOrg(CURRENT_SESSION)).toBe(orgB);
    expect(await userLastActiveOrg(userId)).toBe(orgB);
  });

  it("leaves the user's other sessions and other users as they were", async () => {
    await setActiveOrg(userId, CURRENT_SESSION, orgB);

    expect(await sessionActiveOrg(OTHER_SESSION)).toBe(orgA);
    expect(await userLastActiveOrg(otherUserId)).toBe(orgA);
  });

  // Both orders, so the test still proves the rollback if the two writes are swapped.
  describe.each(['auth_session', 'users'])('when the %s write fails', (table) => {
    beforeEach(async () => {
      await client.exec(
        `CREATE TRIGGER fail_write BEFORE UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_write()`
      );
    });

    afterEach(async () => {
      await client.exec(`DROP TRIGGER fail_write ON ${table}`);
    });

    it('writes neither row and returns INTERNAL_ERROR', async () => {
      const result = await setActiveOrg(userId, CURRENT_SESSION, orgB);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(await sessionActiveOrg(CURRENT_SESSION)).toBe(orgA);
      expect(await userLastActiveOrg(userId)).toBe(orgA);
    });
  });
});
