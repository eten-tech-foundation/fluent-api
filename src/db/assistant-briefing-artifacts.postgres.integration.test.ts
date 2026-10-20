import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.ASSISTANT_CACHE_TEST_DATABASE_URL;

/** Opt-in proof against a freshly created, disposable local PostgreSQL database. */
describe.skipIf(!connectionString)(
  'assistant cache full PostgreSQL migration and app boot',
  () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
      const url = new URL(connectionString!);
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
        !url.pathname.slice(1).startsWith('phase04_cache_verify_')
      ) {
        throw new Error(
          'Assistant cache integration proof requires a disposable local phase04 database'
        );
      }
      sql = postgres(connectionString!, { max: 2 });
      const existing = await sql<{ count: number }[]>`
      SELECT COUNT(*)::integer AS count FROM information_schema.tables
      WHERE table_schema = 'public'
    `;
      if (existing[0].count !== 0)
        throw new Error('Assistant cache integration database is not fresh');
    });

    afterAll(async () => sql?.end());

    it('applies the full chain and boots the unchanged app with the resulting schema', async () => {
      await migrate(drizzle(sql), {
        migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
      });
      const [artifactTable] = await sql<{ tableName: string }[]>`
      SELECT table_name AS "tableName" FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'assistant_briefing_artifacts'
    `;
      expect(artifactTable).toEqual({ tableName: 'assistant_briefing_artifacts' });

      // Production provisioning creates this before the unchanged API boot; migrations intentionally
      // do not own pg-boss's schema.
      await sql`CREATE SCHEMA pgboss`;
      process.env.DATABASE_URL = connectionString!;
      const { findCompletedBriefing, publishCompletedBriefing } = await import(
        '@/domains/assistant/assistant.cache.repository'
      );
      const artifact = {
        cacheKey: 'd'.repeat(64),
        markdown: 'real PostgreSQL cache proof',
        operationVersion: 'passage-briefing-v1',
        profileVersion: 'fluent-profile-v1',
        resourcePolicyVersion: 'fluent-resource-policy-v1',
        cacheEpoch: '1',
        outputContractVersion: 'fluent-widgets-v1',
        responseLanguageHint: 'en',
        resourceLanguage: 'en',
        sourceLanguageCode: 'eng',
      };
      expect(await publishCompletedBriefing(artifact)).toBe(true);
      expect(await findCompletedBriefing(artifact.cacheKey)).toMatchObject({
        markdown: artifact.markdown,
      });
      const { ensureAiSuggestionQueue, ensureExportQueues, initializeQueue, stopQueue } =
        await import('@/lib/queue');
      const boss = await initializeQueue();
      try {
        await ensureExportQueues(boss);
        await ensureAiSuggestionQueue(boss);
        const { default: app } = await import('@/app');
        const response = await app.request('/health');
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ status: 'healthy' });
      } finally {
        await stopQueue();
      }
    });
  },
  60000
);
