import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { err, ErrorCode, ok } from '@/lib/types';

import { runInTransaction } from './transaction';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));

async function names(): Promise<string[]> {
  const rows = await database.execute<{ name: string }>(sql`SELECT name FROM items ORDER BY name`);
  return rows.rows.map((row) => row.name);
}

describe('runInTransaction (PGlite)', () => {
  beforeAll(async () => {
    await database.execute(sql`CREATE TABLE items (name text NOT NULL)`);
  });

  beforeEach(async () => {
    await database.execute(sql`DELETE FROM items`);
  });

  afterAll(async () => {
    await client.close();
  });

  it('commits when the work returns ok', async () => {
    const result = await runInTransaction(async (tx) => {
      await tx.execute(sql`INSERT INTO items VALUES ('kept')`);
      return ok('done');
    });

    expect(result).toEqual(ok('done'));
    expect(await names()).toEqual(['kept']);
  });

  it('rolls back and returns the error unchanged when the work returns err', async () => {
    const result = await runInTransaction(async (tx) => {
      await tx.execute(sql`INSERT INTO items VALUES ('discarded')`);
      return err(ErrorCode.VALIDATION_ERROR);
    });

    expect(result).toEqual(err(ErrorCode.VALIDATION_ERROR));
    expect(await names()).toEqual([]);
  });

  it('rolls back and rethrows unexpected exceptions', async () => {
    const failure = new Error('driver failure');

    await expect(
      runInTransaction(async (tx) => {
        await tx.execute(sql`INSERT INTO items VALUES ('discarded')`);
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await names()).toEqual([]);
  });

  it('rolls back only the nested unit of work when given an outer transaction', async () => {
    const result = await runInTransaction(async (tx) => {
      await tx.execute(sql`INSERT INTO items VALUES ('outer')`);
      const inner = await runInTransaction(async (innerTx) => {
        await innerTx.execute(sql`INSERT INTO items VALUES ('inner')`);
        return err(ErrorCode.CONFLICT);
      }, tx);
      expect(inner).toEqual(err(ErrorCode.CONFLICT));
      return ok(undefined);
    });

    expect(result.ok).toBe(true);
    expect(await names()).toEqual(['outer']);
  });
});
