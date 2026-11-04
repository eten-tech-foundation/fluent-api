import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { db } from '@/db';
import { authAccount, authUser, users } from '@/db/schema';

import { reconcileSeedUser } from './dev-users';

const created: { userId: number; authId: string }[] = [];

async function makeAccount(withCredential: boolean) {
  const suffix = randomUUID().slice(0, 8);
  const email = `t-${suffix}@seed.test`;
  const username = `u-${suffix}`;
  const authId = randomUUID();
  await db.insert(authUser).values({ id: authId, email, name: username });
  const [u] = await db
    .insert(users)
    .values({ username, email, authUserId: authId })
    .returning({ id: users.id });
  if (withCredential) {
    await db.insert(authAccount).values({
      id: randomUUID(),
      userId: authId,
      accountId: email,
      providerId: 'credential',
      password: 'old:hash',
    });
  }
  created.push({ userId: u.id, authId });
  return { email, username, userId: u.id, authId };
}

afterAll(async () => {
  for (const c of created) {
    await db.delete(users).where(eq(users.id, c.userId));
    await db.delete(authAccount).where(eq(authAccount.userId, c.authId));
    await db.delete(authUser).where(eq(authUser.id, c.authId));
  }
});

describe('reconcileSeedUser credential converge (real database)', () => {
  it('inserts a credential account when the existing user has none', async () => {
    const acct = await makeAccount(false);
    const result = await reconcileSeedUser({
      email: acct.email,
      username: acct.username,
      passwordHash: 'newhash:newhash',
      createdBy: null,
    });
    expect(result).toBe(acct.userId);
    const rows = await db.select().from(authAccount).where(eq(authAccount.userId, acct.authId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      providerId: 'credential',
      accountId: acct.email,
      password: 'newhash:newhash',
    });
  });

  it('rotates the stored hash on an existing credential account', async () => {
    const acct = await makeAccount(true);
    const result = await reconcileSeedUser({
      email: acct.email,
      username: acct.username,
      passwordHash: 'rotated:hash',
      createdBy: null,
    });
    expect(result).toBe(acct.userId);
    const rows = await db.select().from(authAccount).where(eq(authAccount.userId, acct.authId));
    expect(rows).toHaveLength(1);
    expect(rows[0].password).toBe('rotated:hash');
  });
});
