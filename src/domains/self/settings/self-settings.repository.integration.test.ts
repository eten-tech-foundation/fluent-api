import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import * as repo from './self-settings.repository';

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

/**
 * PGlite proves the JSONB merge/delete SQL against a real Postgres engine.
 * Overlapping Promise.all here exercises ON CONFLICT merge under single-
 * connection scheduling — not a multi-session Postgres race. See the worktree
 * receipt for the missing proof.
 */
describe('self-settings.repository.mergePatch (PGlite)', () => {
  beforeAll(async () => {
    // Fixture through the shared createTestSchema path like every sibling suite.
    // The users FK is kept, so seed the user ids the suite writes against.
    await createTestSchema(client, {
      authUser: schema.authUser,
      organizations: schema.organizations,
      users: schema.users,
      userStatusEnum: schema.userStatusEnum,
      user_settings: schema.user_settings,
    });
    await database.insert(schema.users).values([
      { id: 1, username: 'settings-u1', email: 'settings-u1@example.com' },
      { id: 2, username: 'settings-u2', email: 'settings-u2@example.com' },
      { id: 3, username: 'settings-u3', email: 'settings-u3@example.com' },
    ]);
  }, 30_000);

  beforeEach(async () => {
    await database.execute(sql`DELETE FROM ${schema.user_settings}`);
  });

  afterAll(async () => {
    await client.close();
  });

  it('merges different keys and strips deletion-nulls', async () => {
    const first = await repo.mergePatch({
      userId: 1,
      patch: { displayMode: 'pericope' },
    });
    expect(first.ok).toBe(true);

    const second = await repo.mergePatch({
      userId: 1,
      patch: { checkIgnoredWordPairs: { 'the the': 'suppress' } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.data.settings).toEqual({
      displayMode: 'pericope',
      checkIgnoredWordPairs: { 'the the': 'suppress' },
    });

    const deleted = await repo.mergePatch({
      userId: 1,
      patch: { displayMode: null },
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.data.settings).toEqual({
      checkIgnoredWordPairs: { 'the the': 'suppress' },
    });
    expect(deleted.data.settings).not.toHaveProperty('displayMode');
  });

  it('retains both keys when overlapping different-key patches hit ON CONFLICT on first insert (single-connection scheduling)', async () => {
    const [a, b] = await Promise.all([
      repo.mergePatch({ userId: 2, patch: { displayMode: 'verse' } }),
      repo.mergePatch({
        userId: 2,
        patch: { checkIgnoredWordPairs: { 'and and': 'surface' } },
      }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const row = await repo.findByUser(2);
    expect(row.ok).toBe(true);
    if (!row.ok || !row.data) return;
    expect(row.data.settings).toEqual({
      displayMode: 'verse',
      checkIgnoredWordPairs: { 'and and': 'surface' },
    });
  });

  it('same-key last successful save wins', async () => {
    await repo.mergePatch({ userId: 3, patch: { displayMode: 'verse' } });
    await repo.mergePatch({ userId: 3, patch: { displayMode: 'pericope' } });
    const row = await repo.findByUser(3);
    expect(row.ok).toBe(true);
    if (!row.ok || !row.data) return;
    expect(row.data.settings).toEqual({ displayMode: 'pericope' });
  });
});
