import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_CACHE_POOL_SIZE,
  ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
  AssistantCacheUnavailableError,
  cleanupExpiredArtifacts,
  findCompletedArtifact,
  publishCompletedArtifact,
  requestExpiredArtifactCleanup,
} from './cache/assistant-cache.repository';

const databaseState = vi.hoisted(() => ({
  client: undefined as PGlite | undefined,
  beforeQuery: undefined as (() => Promise<void>) | undefined,
  pools: [] as Array<{ end: ReturnType<typeof vi.fn> }>,
}));
const postgresFactory = vi.hoisted(() => vi.fn());

vi.mock('postgres', () => ({
  default: postgresFactory.mockImplementation((_url: string, _options: unknown) => {
    let ended = false;
    const pending = new Set<(error: Error) => void>();
    const pool = {
      unsafe: (text: string, parameters: unknown[]) => {
        let rejectQuery!: (error: Error) => void;
        const operation = (async () => {
          await databaseState.beforeQuery?.();
          if (ended) throw new Error('transport destroyed before execution');
          const result = await databaseState.client!.query(text, parameters);
          return result.rows;
        })();
        const query = new Promise((resolve, reject) => {
          rejectQuery = reject;
          pending.add(reject);
          operation.then(
            (value) => {
              pending.delete(rejectQuery);
              resolve(value);
            },
            (error) => {
              pending.delete(rejectQuery);
              reject(error);
            }
          );
        });
        return query;
      },
      end: vi.fn(async () => {
        ended = true;
        for (const reject of pending) reject(new Error('transport destroyed'));
        pending.clear();
      }),
    };
    databaseState.pools.push(pool);
    return pool;
  }),
}));

let client: PGlite;
const keys: string[] = [];

function artifact(markdown: string) {
  const cacheKey = randomBytes(32).toString('hex');
  keys.push(cacheKey);
  return {
    cacheKey,
    markdown,
    cacheEpoch: '1',
    outputContractVersion: 'fluent-widgets-v1',
  };
}

beforeAll(async () => {
  client = new PGlite();
  databaseState.client = client;
  const migrations = await Promise.all(
    ['0041_assistant_artifacts.sql', '0042_assistant_artifacts.sql'].map((name) =>
      readFile(new URL(`../../db/migrations/${name}`, import.meta.url), 'utf8')
    )
  );
  for (const migration of migrations) await client.exec(migration);
});

afterEach(async () => {
  databaseState.beforeQuery = undefined;
  vi.useRealTimers();
  if (keys.length)
    await client.query('DELETE FROM assistant_artifacts WHERE cache_key = ANY($1)', [
      keys.splice(0),
    ]);
});

afterAll(async () => client.close());

describe('assistant completed briefing repository', () => {
  it.each(['', ' \n\t '])(
    'rejects blank writes and ignores old blank artifacts (%j)',
    async (markdown) => {
      const row = artifact(markdown);
      expect(await publishCompletedArtifact(row)).toBe(false);
      expect(await findCompletedArtifact(row.cacheKey)).toBeNull();
      expect(await publishCompletedArtifact({ ...row, markdown: 'valid' })).toBe(true);
      await client.query('UPDATE assistant_artifacts SET markdown = $1 WHERE cache_key = $2', [
        markdown,
        row.cacheKey,
      ]);
      expect(await findCompletedArtifact(row.cacheKey)).toBeNull();
    }
  );

  it('uses an isolated bounded pool with server-side timeouts', () => {
    expect(postgresFactory).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max: ASSISTANT_CACHE_POOL_SIZE,
        connect_timeout: 2,
        connection: expect.objectContaining({
          statement_timeout: ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
          lock_timeout: expect.any(Number),
        }),
      })
    );
  });

  it('reads by the database clock and keeps the first unexpired completion immutable', async () => {
    const first = artifact('first');
    expect(await publishCompletedArtifact(first)).toBe(true);
    expect(await publishCompletedArtifact({ ...first, markdown: 'second' })).toBe(false);
    expect(await findCompletedArtifact(first.cacheKey)).toMatchObject({ markdown: 'first' });

    await client.query(
      `UPDATE assistant_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE cache_key = $1`,
      [first.cacheKey]
    );
    expect(await findCompletedArtifact(first.cacheKey)).toBeNull();
  });

  it('allows exactly the first concurrent expired-row replacement to win', async () => {
    const expired = artifact('expired');
    await publishCompletedArtifact(expired);
    await client.query(
      `UPDATE assistant_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE cache_key = $1`,
      [expired.cacheKey]
    );

    const results = await Promise.all([
      publishCompletedArtifact({ ...expired, markdown: 'refresh-a' }),
      publishCompletedArtifact({ ...expired, markdown: 'refresh-b' }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await findCompletedArtifact(expired.cacheKey))?.markdown).toMatch(/^refresh-[ab]$/);
  });

  it('deletes expired hashes in bounded batches without racing an unexpired row', async () => {
    const expiredA = artifact('expired-a');
    const expiredB = artifact('expired-b');
    const live = artifact('live');
    await Promise.all([publishCompletedArtifact(expiredA), publishCompletedArtifact(expiredB)]);
    await publishCompletedArtifact(live);
    await client.query(
      `UPDATE assistant_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE cache_key = ANY($1)`,
      [[expiredA.cacheKey, expiredB.cacheKey]]
    );

    expect(await cleanupExpiredArtifacts(1)).toBe(1);
    expect(await cleanupExpiredArtifacts(1)).toBe(1);
    expect(await findCompletedArtifact(live.cacheKey)).toMatchObject({ markdown: 'live' });
  });

  it('rejects excess work immediately rather than queueing behind its two connections', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    databaseState.beforeQuery = () => gate;
    const first = findCompletedArtifact('a'.repeat(64));
    const second = findCompletedArtifact('b'.repeat(64));
    await expect(findCompletedArtifact('c'.repeat(64))).rejects.toThrow(
      AssistantCacheUnavailableError
    );
    release();
    await Promise.all([first, second]);
  });

  it('destroys a stalled transport, settles concurrent work, and recovers on a fresh pool', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    databaseState.beforeQuery = () => gate;
    const late = artifact('must-not-persist');
    const collateral = artifact('also-must-not-persist');
    const oldPool = databaseState.pools.at(-1)!;
    const poolCount = postgresFactory.mock.calls.length;
    const writeError = publishCompletedArtifact(late).then(
      () => new Error('unexpected cache write success'),
      (error) => error as Error
    );
    const collateralError = publishCompletedArtifact(collateral).then(
      () => new Error('unexpected collateral write success'),
      (error) => error as Error
    );

    await vi.advanceTimersByTimeAsync(ASSISTANT_CACHE_WRITE_TIMEOUT_MS);
    expect((await writeError).message).toMatch(/write_timeout|transport destroyed/);
    expect((await collateralError).message).toMatch(/write_timeout|transport destroyed/);
    expect(oldPool.end).toHaveBeenCalledOnce();
    expect(oldPool.end).toHaveBeenCalledWith({ timeout: 0 });
    expect(postgresFactory).toHaveBeenCalledTimes(poolCount + 1);
    databaseState.beforeQuery = undefined;
    vi.useRealTimers();

    // A caller arriving immediately after timeout sees a clean miss while the old driver task is
    // still paused. Releasing that would-be late commit cannot change the result.
    expect(await findCompletedArtifact(late.cacheKey)).toBeNull();
    expect(await findCompletedArtifact(collateral.cacheKey)).toBeNull();
    release();
    await Promise.resolve();
    expect(await findCompletedArtifact(late.cacheKey)).toBeNull();
  });
});

it('turn artifacts use DB expiry and conditional first winner without retaining inputs', async () => {
  const key = randomBytes(32).toString('hex');
  const winners = await Promise.all([
    publishCompletedArtifact({
      cacheKey: key,
      markdown: 'first',
      cacheEpoch: '1',
      outputContractVersion: 'fluent-turn-v1',
    }),
    publishCompletedArtifact({
      cacheKey: key,
      markdown: 'second',
      cacheEpoch: '1',
      outputContractVersion: 'fluent-turn-v1',
    }),
  ]);
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(await findCompletedArtifact(key)).toEqual({
    cacheKey: key,
    markdown: 'first',
    cacheEpoch: '1',
    outputContractVersion: 'fluent-turn-v1',
  });
  await client.query(
    "UPDATE assistant_artifacts SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE cache_key = $1",
    [key]
  );
  expect(await findCompletedArtifact(key)).toBeNull();
  expect(
    await publishCompletedArtifact({
      cacheKey: key,
      markdown: 'new',
      cacheEpoch: '1',
      outputContractVersion: 'fluent-turn-v1',
    })
  ).toBe(true);
  expect(await findCompletedArtifact(key)).toMatchObject({ markdown: 'new' });
  const columns = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'assistant_artifacts' ORDER BY ordinal_position"
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    'cache_key',
    'markdown',
    'cache_epoch',
    'output_contract_version',
    'completed_at',
    'expires_at',
  ]);
});

it('cleans expired turn rows in a bounded batch without deleting live artifacts', async () => {
  await client.query(`INSERT INTO assistant_artifacts
    (cache_key, markdown, cache_epoch, output_contract_version, expires_at)
    SELECT lpad(i::text, 64, '0'), 'expired', '1', 'fluent-turn-v1', CURRENT_TIMESTAMP - INTERVAL '1 day'
    FROM generate_series(1, 105) AS i`);
  const onFailure = vi.fn();
  requestExpiredArtifactCleanup(onFailure);
  await vi.waitFor(async () => {
    const result = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM assistant_artifacts WHERE expires_at <= CURRENT_TIMESTAMP'
    );
    expect(result.rows[0].count).toBe(5);
  });
  expect(onFailure).not.toHaveBeenCalled();
  requestExpiredArtifactCleanup(onFailure);
  expect(
    (
      await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM assistant_artifacts WHERE expires_at <= CURRENT_TIMESTAMP'
      )
    ).rows[0].count
  ).toBe(5);
});
