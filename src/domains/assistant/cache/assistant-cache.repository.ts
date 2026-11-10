import { Socket } from 'node:net';
import postgres from 'postgres';

import env from '@/env';

const ASSISTANT_ARTIFACT_TTL_SECONDS = 7 * 24 * 60 * 60;
const ASSISTANT_ARTIFACT_CLEANUP_BATCH = 100;
const ASSISTANT_CACHE_READ_TIMEOUT_MS = 1_500;
export const ASSISTANT_CACHE_WRITE_TIMEOUT_MS = 2_000;
export const ASSISTANT_CACHE_POOL_SIZE = 2;
const CLEANUP_INTERVAL_MS = 60_000;

interface AssistantCachePool {
  sql: postgres.Sql;
  admitted: number;
  generation: number;
  sockets: Set<Socket>;
  retirement?: Promise<void>;
}

interface PostgresSocketOptions {
  host: string[];
  port: number[];
  path?: string;
}

const assistantCacheSockets = new Set<Socket>();
let assistantCachePoolGeneration = 0;

function pruneDestroyedTransports(pool: Pick<AssistantCachePool, 'sockets'>): void {
  for (const socket of pool.sockets) {
    if (!socket.destroyed) continue;
    pool.sockets.delete(socket);
    assistantCacheSockets.delete(socket);
  }
}

function openTrackedSocket(
  pool: Pick<AssistantCachePool, 'sockets'>,
  options: PostgresSocketOptions,
  target: number
): Promise<Socket> {
  const socket = new Socket();
  pool.sockets.add(socket);
  assistantCacheSockets.add(socket);
  const host = options.host[target % options.host.length];
  const port = options.port[target % options.port.length];
  Object.assign(socket, { host, port });

  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('Assistant cache database socket connect timed out'));
    }, 2_000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    socket.once('error', fail);
    socket.once('close', () => {
      pool.sockets.delete(socket);
      assistantCacheSockets.delete(socket);
      fail(new Error('Assistant cache database socket closed before connect'));
    });
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('error', fail);
      resolve(socket);
    });
    if (options.path) socket.connect(options.path);
    else socket.connect(port, host);
  });
}

/** Isolated so disposable cache work cannot consume application database slots. */
function createAssistantCachePool(): AssistantCachePool {
  let target = 0;
  const pool: AssistantCachePool = {
    admitted: 0,
    generation: ++assistantCachePoolGeneration,
    sockets: new Set(),
    sql: undefined as unknown as postgres.Sql,
  };
  pool.sql = postgres(env.DATABASE_URL, {
    max: ASSISTANT_CACHE_POOL_SIZE,
    connect_timeout: 2,
    idle_timeout: 20,
    prepare: false,
    fetch_types: false,
    connection: {
      application_name: 'fluent-assistant-cache',
      statement_timeout: ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
      lock_timeout: ASSISTANT_CACHE_READ_TIMEOUT_MS,
    },
    socket: (options: PostgresSocketOptions) => openTrackedSocket(pool, options, target++),
  } as postgres.Options<Record<string, never>>);
  return pool;
}

let currentCachePool = createAssistantCachePool();
let cleanupStartedAt: number | null = null;
let cleanupInFlight: Promise<number> | null = null;

export class AssistantCacheUnavailableError extends Error {
  constructor(reason: 'busy' | 'read_timeout' | 'write_timeout' | 'aborted') {
    super(`Assistant cache ${reason}`);
    this.name = 'AssistantCacheUnavailableError';
  }
}

function retireAssistantCachePool(pool: AssistantCachePool): void {
  if (pool.retirement) return;
  if (currentCachePool === pool) currentCachePool = createAssistantCachePool();
  // postgres.js `end({ timeout: 0 })` only half-closes active TCP sockets. Own and destroy the
  // underlying transports first; pool end then settles driver bookkeeping and queued queries.
  const closingSockets = [...pool.sockets].map(
    (socket) =>
      new Promise<void>((resolve) => {
        const closed = () => {
          pool.sockets.delete(socket);
          assistantCacheSockets.delete(socket);
          resolve();
        };
        if (socket.destroyed) return closed();
        socket.once('close', closed);
        socket.destroy();
      })
  );
  const endingPool = pool.sql.end({ timeout: 0 });
  pool.retirement = Promise.allSettled([...closingSockets, endingPool]).then(() => undefined);
}

export function assistantCacheOpenTransportCountForTests(): number {
  if (process.env.NODE_ENV !== 'test') throw new Error('test helper used outside tests');
  return assistantCacheSockets.size;
}

export function assistantCachePoolGenerationForTests(): number {
  if (process.env.NODE_ENV !== 'test') throw new Error('test helper used outside tests');
  return currentCachePool.generation;
}

function executeCacheQuery<T>(input: {
  text: string;
  parameters: unknown[];
  timeoutMs: number;
  timeoutReason: 'read_timeout' | 'write_timeout';
  signal?: AbortSignal;
}): Promise<T> {
  const pool = currentCachePool;
  // postgres.js removes listeners from the raw socket during its TLS upgrade. Pruning at
  // admission and settlement keeps ordinary disconnects from retaining those transports.
  pruneDestroyedTransports(pool);
  if (pool.admitted >= ASSISTANT_CACHE_POOL_SIZE)
    return Promise.reject(new AssistantCacheUnavailableError('busy'));
  pool.admitted++;

  return (async () => {
    let timer: NodeJS.Timeout | undefined;
    let cancellation: AssistantCacheUnavailableError | undefined;
    const terminateTransport = (reason: AssistantCacheUnavailableError) => {
      if (cancellation) return;
      cancellation = reason;
      retireAssistantCachePool(pool);
    };
    const onAbort = () => terminateTransport(new AssistantCacheUnavailableError('aborted'));
    try {
      if (input.signal?.aborted) throw new AssistantCacheUnavailableError('aborted');
      const query = pool.sql.unsafe(
        input.text,
        input.parameters as never[]
      ) as unknown as Promise<T>;
      input.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => terminateTransport(new AssistantCacheUnavailableError(input.timeoutReason)),
        input.timeoutMs
      );
      try {
        return await query;
      } catch (error) {
        throw cancellation ?? error;
      }
    } finally {
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', onAbort);
      pool.admitted--;
      pruneDestroyedTransports(pool);
    }
  })();
}

export interface CompletedAssistantArtifact {
  cacheKey: string;
  markdown: string;
  cacheEpoch: string;
  outputContractVersion: string;
}

/** Reads only artifacts that are unexpired according to the database clock. */
export async function findCompletedArtifact(
  cacheKey: string,
  signal?: AbortSignal
): Promise<CompletedAssistantArtifact | null> {
  const rows = await executeCacheQuery<CompletedAssistantArtifact[]>({
    text: `SELECT cache_key AS "cacheKey", markdown, cache_epoch AS "cacheEpoch",
      output_contract_version AS "outputContractVersion" FROM assistant_artifacts
      WHERE cache_key = $1 AND expires_at > CURRENT_TIMESTAMP
      LIMIT 1`,
    parameters: [cacheKey],
    timeoutMs: ASSISTANT_CACHE_READ_TIMEOUT_MS,
    timeoutReason: 'read_timeout',
    signal,
  });
  return rows[0]?.markdown.trim() ? rows[0] : null;
}

/** First-winner publication; an expired conflict can be replaced only while still expired. */
export async function publishCompletedArtifact(
  artifact: CompletedAssistantArtifact,
  signal?: AbortSignal
): Promise<boolean> {
  if (!artifact.markdown.trim()) return false;
  const rows = await executeCacheQuery<{ cacheKey: string }[]>({
    text: `INSERT INTO assistant_artifacts (
      cache_key, markdown, cache_epoch, output_contract_version, completed_at, expires_at
    ) VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP + (${ASSISTANT_ARTIFACT_TTL_SECONDS} * INTERVAL '1 second'))
    ON CONFLICT (cache_key) DO UPDATE SET
      markdown = EXCLUDED.markdown, cache_epoch = EXCLUDED.cache_epoch,
      output_contract_version = EXCLUDED.output_contract_version,
      completed_at = CURRENT_TIMESTAMP,
      expires_at = CURRENT_TIMESTAMP + (${ASSISTANT_ARTIFACT_TTL_SECONDS} * INTERVAL '1 second')
    WHERE assistant_artifacts.expires_at <= CURRENT_TIMESTAMP
    RETURNING cache_key AS "cacheKey"`,
    parameters: [
      artifact.cacheKey,
      artifact.markdown,
      artifact.cacheEpoch,
      artifact.outputContractVersion,
    ],
    timeoutMs: ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
    timeoutReason: 'write_timeout',
    signal,
  });
  return rows.length === 1;
}

/** Opportunistic bounded deletion; the repeated predicate protects a refreshed row. */
export async function cleanupExpiredArtifacts(
  batchSize = ASSISTANT_ARTIFACT_CLEANUP_BATCH
): Promise<number> {
  const rows = await executeCacheQuery<{ cacheKey: string }[]>({
    text: `WITH expired AS (
      SELECT cache_key FROM assistant_artifacts
      WHERE expires_at <= CURRENT_TIMESTAMP ORDER BY expires_at, cache_key LIMIT $1
    )
    DELETE FROM assistant_artifacts USING expired
    WHERE assistant_artifacts.cache_key = expired.cache_key
      AND assistant_artifacts.expires_at <= CURRENT_TIMESTAMP
    RETURNING assistant_artifacts.cache_key AS "cacheKey"`,
    parameters: [batchSize],
    timeoutMs: ASSISTANT_CACHE_WRITE_TIMEOUT_MS,
    timeoutReason: 'write_timeout',
  });
  return rows.length;
}

/** Coalesces and rate-limits request-path cleanup; callers never await it. */
export function requestExpiredArtifactCleanup(onFailure: () => void): void {
  const now = Date.now();
  if (
    cleanupInFlight ||
    (cleanupStartedAt !== null && now - cleanupStartedAt < CLEANUP_INTERVAL_MS)
  )
    return;
  cleanupStartedAt = now;
  cleanupInFlight = cleanupExpiredArtifacts()
    .catch(() => {
      onFailure();
      return 0;
    })
    .finally(() => {
      cleanupInFlight = null;
    });
}
