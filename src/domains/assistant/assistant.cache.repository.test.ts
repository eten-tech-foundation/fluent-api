import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  ASSISTANT_CACHE_POOL_SIZE,
  ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
  BriefingCacheUnavailableError,
  cleanupExpiredBriefings,
  findCompletedBriefing,
  findCompletedTurn,
  publishCompletedBriefing,
  publishCompletedTurn,
  requestExpiredTurnCleanup,
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
    operationVersion: 'passage-briefing-v1',
    profileVersion: 'fluent-profile-v1',
    resourcePolicyVersion: 'fluent-resource-policy-v1',
    cacheEpoch: '1',
    outputContractVersion: 'fluent-widgets-v1',
    responseLanguageHint: 'en',
    resourceLanguage: 'en',
    sourceLanguageCode: 'eng',
  };
}

beforeAll(async () => {
  client = new PGlite();
  databaseState.client = client;
  const migration = await readFile(
    new URL('../../db/migrations/0041_assistant_artifacts.sql', import.meta.url),
    'utf8'
  );
  await client.exec(migration);
});

afterEach(async () => {
  databaseState.beforeQuery = undefined;
  vi.useRealTimers();
  if (keys.length)
    await client.query('DELETE FROM assistant_briefing_artifacts WHERE cache_key = ANY($1)', [
      keys.splice(0),
    ]);
});

afterAll(async () => client.close());

describe('assistant completed briefing repository', () => {
  it.each(['', ' \n\t '])(
    'rejects blank writes and ignores old blank artifacts (%j)',
    async (markdown) => {
      const row = artifact(markdown);
      expect(await publishCompletedBriefing(row)).toBe(false);
      expect(await findCompletedBriefing(row.cacheKey)).toBeNull();
      expect(await publishCompletedBriefing({ ...row, markdown: 'valid' })).toBe(true);
      await client.query(
        'UPDATE assistant_briefing_artifacts SET markdown = $1 WHERE cache_key = $2',
        [markdown, row.cacheKey]
      );
      expect(await findCompletedBriefing(row.cacheKey)).toBeNull();
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
    expect(await publishCompletedBriefing(first)).toBe(true);
    expect(await publishCompletedBriefing({ ...first, markdown: 'second' })).toBe(false);
    expect(await findCompletedBriefing(first.cacheKey)).toMatchObject({ markdown: 'first' });

    await client.query(
      `UPDATE assistant_briefing_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE cache_key = $1`,
      [first.cacheKey]
    );
    expect(await findCompletedBriefing(first.cacheKey)).toBeNull();
  });

  it('allows exactly the first concurrent expired-row replacement to win', async () => {
    const expired = artifact('expired');
    await publishCompletedBriefing(expired);
    await client.query(
      `UPDATE assistant_briefing_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE cache_key = $1`,
      [expired.cacheKey]
    );

    const results = await Promise.all([
      publishCompletedBriefing({ ...expired, markdown: 'refresh-a' }),
      publishCompletedBriefing({ ...expired, markdown: 'refresh-b' }),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect((await findCompletedBriefing(expired.cacheKey))?.markdown).toMatch(/^refresh-[ab]$/);
  });

  it('deletes expired hashes in bounded batches without racing an unexpired row', async () => {
    const expiredA = artifact('expired-a');
    const expiredB = artifact('expired-b');
    const live = artifact('live');
    await Promise.all([publishCompletedBriefing(expiredA), publishCompletedBriefing(expiredB)]);
    await publishCompletedBriefing(live);
    await client.query(
      `UPDATE assistant_briefing_artifacts
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second'
       WHERE cache_key = ANY($1)`,
      [[expiredA.cacheKey, expiredB.cacheKey]]
    );

    expect(await cleanupExpiredBriefings(1)).toBe(1);
    expect(await cleanupExpiredBriefings(1)).toBe(1);
    expect(await findCompletedBriefing(live.cacheKey)).toMatchObject({ markdown: 'live' });
  });

  it('rejects excess work immediately rather than queueing behind its two connections', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    databaseState.beforeQuery = () => gate;
    const first = findCompletedBriefing('a'.repeat(64));
    const second = findCompletedBriefing('b'.repeat(64));
    await expect(findCompletedBriefing('c'.repeat(64))).rejects.toThrow(
      BriefingCacheUnavailableError
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
    const writeError = publishCompletedBriefing(late).then(
      () => new Error('unexpected cache write success'),
      (error) => error as Error
    );
    const collateralError = publishCompletedBriefing(collateral).then(
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
    expect(await findCompletedBriefing(late.cacheKey)).toBeNull();
    expect(await findCompletedBriefing(collateral.cacheKey)).toBeNull();
    release();
    await Promise.resolve();
    expect(await findCompletedBriefing(late.cacheKey)).toBeNull();
  });
});

it('turn artifacts use DB expiry and conditional first winner without retaining inputs', async () => {
  const key = randomBytes(32).toString('hex');
  const winners = await Promise.all([
    publishCompletedTurn(key, 'first', 'fluent-turn-v1'),
    publishCompletedTurn(key, 'second', 'fluent-turn-v1'),
  ]);
  expect(winners.filter(Boolean)).toHaveLength(1);
  expect(await findCompletedTurn(key)).toEqual({
    markdown: 'first',
    outputContractVersion: 'fluent-turn-v1',
  });
  await client.query(
    "UPDATE assistant_turn_artifacts SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 day' WHERE cache_key = $1",
    [key]
  );
  expect(await findCompletedTurn(key)).toBeNull();
  expect(await publishCompletedTurn(key, 'new', 'fluent-turn-v1')).toBe(true);
  expect(await findCompletedTurn(key)).toMatchObject({ markdown: 'new' });
  const columns = await client.query<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'assistant_turn_artifacts' ORDER BY ordinal_position"
  );
  expect(columns.rows.map((row) => row.column_name)).toEqual([
    'cache_key',
    'markdown',
    'output_contract_version',
    'completed_at',
    'expires_at',
  ]);
});

it('cleans expired turn rows in a bounded batch without deleting live artifacts', async () => {
  await client.query(`INSERT INTO assistant_turn_artifacts
    (cache_key, markdown, output_contract_version, expires_at)
    SELECT lpad(i::text, 64, '0'), 'expired', 'fluent-turn-v1', CURRENT_TIMESTAMP - INTERVAL '1 day'
    FROM generate_series(1, 105) AS i`);
  const onFailure = vi.fn();
  requestExpiredTurnCleanup(onFailure);
  await vi.waitFor(async () => {
    const result = await client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM assistant_turn_artifacts WHERE expires_at <= CURRENT_TIMESTAMP'
    );
    expect(result.rows[0].count).toBe(5);
  });
  expect(onFailure).not.toHaveBeenCalled();
  requestExpiredTurnCleanup(onFailure);
  expect(
    (
      await client.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM assistant_turn_artifacts WHERE expires_at <= CURRENT_TIMESTAMP'
      )
    ).rows[0].count
  ).toBe(5);
});
