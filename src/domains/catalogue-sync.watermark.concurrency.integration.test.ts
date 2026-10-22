import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  migrationStatements,
  PROVIDER_RESOURCE_LICENSE_TRIGGER_SQL,
} from '@/db/testing/create-catalogue-schema';

/**
 * Multi-session PostgreSQL regressions for #404. PGlite cannot exercise
 * competing transactions. Gated on WATERMARK_TEST_DATABASE_URL (never
 * DATABASE_URL / shared Dev/QA). Pattern mirrors dlq-integration.
 */
const connectionString = process.env.WATERMARK_TEST_DATABASE_URL;

type ReservedSql = Awaited<ReturnType<postgres.Sql['reserve']>>;

interface ConcurrencyOp {
  label: string;
  table: 'books' | 'languages' | 'bibles';
  write: (args: {
    early: ReservedSql;
    key: string;
    bibleId: number;
    languageId: number;
    resourceId: number;
  }) => Promise<{ updated_at: Date }>;
}

const concurrencyOps: ConcurrencyOp[] = [
  {
    label: 'book insert',
    table: 'books',
    write: async ({ early, key }) => {
      const [changed] = await early`
          INSERT INTO books (code, eng_display_name) VALUES (${key}, 'Late book')
          RETURNING updated_at`;
      return changed! as { updated_at: Date };
    },
  },
  {
    label: 'bible update',
    table: 'bibles',
    write: async ({ early, bibleId }) => {
      const [changed] = await early`
          UPDATE bibles SET has_audio = true, updated_at = next_catalogue_watermark()
          WHERE id = ${bibleId} RETURNING updated_at`;
      return changed! as { updated_at: Date };
    },
  },
  {
    label: 'language fill',
    table: 'languages',
    write: async ({ early, languageId }) => {
      const [changed] = await early`
          UPDATE languages SET lang_name_localized = 'Filled', updated_at = next_catalogue_watermark()
          WHERE id = ${languageId} RETURNING updated_at`;
      return changed! as { updated_at: Date };
    },
  },
  {
    label: 'license trigger',
    table: 'bibles',
    write: async ({ early, bibleId, resourceId }) => {
      await early`
          UPDATE bible_provider_resources SET tts_license_status = 'allowed'
          WHERE id = ${resourceId}`;
      const [changed] = await early`SELECT updated_at FROM bibles WHERE id = ${bibleId}`;
      return changed! as { updated_at: Date };
    },
  },
];

describe.skipIf(!connectionString)('catalogue watermark commit ordering (PostgreSQL)', () => {
  const sql = postgres(connectionString!, { max: 4 });

  beforeAll(async () => {
    const url = new URL(connectionString!);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.pathname !== '/fluent_watermark_test'
    ) {
      throw new Error(
        'Watermark tests require a disposable local database named fluent_watermark_test'
      );
    }

    // Minimal catalogue surface + allocator. Do not point at a shared DB.
    await sql`DROP SCHEMA public CASCADE`;
    await sql`CREATE SCHEMA public`;
    await sql`CREATE TYPE bible_provider AS ENUM ('dbl')`;
    await sql`CREATE TYPE resource_provider AS ENUM ('dbl', 'aquifer', 'youversion')`;
    await sql`CREATE TYPE tts_license_status AS ENUM ('allowed', 'forbidden', 'unknown')`;
    await sql`
        CREATE TABLE languages (
          id serial PRIMARY KEY,
          lang_name varchar(255) NOT NULL,
          lang_name_localized varchar(255),
          lang_code_iso_639_3 varchar(3) UNIQUE,
          updated_at timestamp DEFAULT now()
        )`;
    await sql`
        CREATE TABLE books (
          id serial PRIMARY KEY,
          code varchar(50) NOT NULL UNIQUE,
          eng_display_name varchar(255) NOT NULL,
          updated_at timestamp DEFAULT now()
        )`;
    await sql`
        CREATE TABLE bible_provider_resources (
          id serial PRIMARY KEY,
          provider resource_provider NOT NULL,
          external_id varchar(255) NOT NULL,
          tts_license_status tts_license_status NOT NULL DEFAULT 'unknown',
          license_notice text,
          display_name text
        )`;
    await sql`
        CREATE TABLE bibles (
          id serial PRIMARY KEY,
          language_id integer NOT NULL REFERENCES languages(id),
          name varchar(255) NOT NULL UNIQUE,
          abbreviation varchar(50) NOT NULL UNIQUE,
          provider bible_provider NOT NULL DEFAULT 'dbl',
          external_id varchar(255),
          has_audio boolean NOT NULL DEFAULT false,
          audio_resource_id integer REFERENCES bible_provider_resources(id),
          updated_at timestamp DEFAULT now()
        )`;

    for (const statement of migrationStatements('0038_catalogue_watermark_allocator.sql')) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(PROVIDER_RESOURCE_LICENSE_TRIGGER_SQL);
  }, 60_000);

  afterAll(async () => {
    await sql.end();
  });

  it.each(concurrencyOps)(
    '$label cannot be lost when a cursor advances during a transaction',
    async ({ table, write }) => {
      const key = randomUUID();
      const [language] = await sql`INSERT INTO languages (lang_name) VALUES (${key}) RETURNING id`;
      const [bible] = await sql`
          INSERT INTO bibles (language_id, name, abbreviation, provider, external_id)
          VALUES (${language!.id}, ${key}, ${key}, 'dbl', ${key}) RETURNING id`;
      const [resource] = await sql`
          INSERT INTO bible_provider_resources (provider, external_id)
          VALUES ('dbl', ${key}) RETURNING id`;
      const early = await sql.reserve();
      const later = await sql.reserve();
      let committed = false;
      let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
      try {
        // Start early, issue a newer committed cursor, then write in the old
        // transaction. now() would assign a watermark behind this cursor.
        await early`BEGIN`;
        const [cursorRow] = await sql`
            INSERT INTO books (code, eng_display_name) VALUES (${`cursor-${key}`}, 'Cursor')
            RETURNING updated_at`;
        const cursor = cursorRow!.updated_at as Date;
        const changed = await write({
          early,
          key,
          bibleId: bible!.id,
          languageId: language!.id,
          resourceId: resource!.id,
        });
        expect(changed.updated_at.getTime()).toBeGreaterThan(cursor.getTime());

        // While this write is invisible, a later writer must wait: it cannot
        // commit a cursor that would skip the in-flight row.
        const [connection] = await later`SELECT pg_backend_pid() AS pid`;
        pending = later`
            INSERT INTO books (code, eng_display_name) VALUES (${`later-${key}`}, 'Later')
            RETURNING updated_at`.execute();
        await expect
          .poll(async () => {
            const [state] =
              await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`;
            return Number(state!.count);
          })
          .toBeGreaterThan(0);
        await early`COMMIT`;
        committed = true;
        const [newer] = await pending;
        expect((newer!.updated_at as Date).getTime()).toBeGreaterThan(changed.updated_at.getTime());
        const rows = await sql`SELECT updated_at FROM ${sql(table)} WHERE updated_at >= ${cursor}`;
        expect(rows.map((row) => (row.updated_at as Date).getTime())).toContain(
          changed.updated_at.getTime()
        );
      } finally {
        if (!committed) await early`ROLLBACK`;
        await pending?.catch(() => {});
        early.release();
        later.release();
        await sql`DELETE FROM bibles WHERE id = ${bible!.id}`;
        await sql`DELETE FROM bible_provider_resources WHERE id = ${resource!.id}`;
        await sql`DELETE FROM languages WHERE id = ${language!.id}`;
        await sql`DELETE FROM books WHERE code IN (${key}, ${`cursor-${key}`}, ${`later-${key}`})`;
      }
    }
  );

  it('releases the singleton on ROLLBACK so a blocked later writer proceeds', async () => {
    const key = randomUUID();
    const early = await sql.reserve();
    const later = await sql.reserve();
    let pending: Promise<postgres.RowList<postgres.Row[]>> | undefined;
    try {
      await early`BEGIN`;
      await early`
          INSERT INTO books (code, eng_display_name) VALUES (${key}, 'Early rollback')
          RETURNING updated_at`;

      const [connection] = await later`SELECT pg_backend_pid() AS pid`;
      pending = later`
          INSERT INTO books (code, eng_display_name) VALUES (${`later-${key}`}, 'Later')
          RETURNING updated_at`.execute();
      await expect
        .poll(async () => {
          const [state] =
            await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`;
          return Number(state!.count);
        })
        .toBeGreaterThan(0);

      await early`ROLLBACK`;
      const [newer] = await pending;
      expect((newer!.updated_at as Date).getTime()).toBeGreaterThan(0);

      const rolledBack = await sql`SELECT code FROM books WHERE code = ${key}`;
      expect(rolledBack).toEqual([]);
      const proceeded = await sql`SELECT code FROM books WHERE code = ${`later-${key}`}`;
      expect(proceeded.map((row) => row.code)).toEqual([`later-${key}`]);
    } finally {
      await pending?.catch(() => {});
      early.release();
      later.release();
      await sql`DELETE FROM books WHERE code IN (${key}, ${`later-${key}`})`;
    }
  });

  it('documents that now()-stamped writes can fall behind a concurrent cursor', async () => {
    // Regression baseline: same race with transaction-start now() (no allocator
    // lock). The late-commit row lands behind the cursor issued mid-flight.
    const key = randomUUID();
    const early = await sql.reserve();
    let committed = false;
    try {
      await early`BEGIN`;
      // Hold the early transaction open without taking the catalogue lock.
      await early`SELECT 1`;
      // Ensure wall clock advances past early's transaction-start now().
      await new Promise((resolve) => setTimeout(resolve, 5));
      const [cursorRow] = await sql`
          INSERT INTO books (code, eng_display_name)
          VALUES (${`cursor-now-${key}`}, 'Cursor')
          RETURNING updated_at`;
      const cursor = cursorRow!.updated_at as Date;
      const [changed] = await early`
          INSERT INTO books (code, eng_display_name, updated_at)
          VALUES (${`late-now-${key}`}, 'Late', now())
          RETURNING updated_at`;
      await early`COMMIT`;
      committed = true;
      expect((changed!.updated_at as Date).getTime()).toBeLessThan(cursor.getTime());
      const missed =
        await sql`SELECT code FROM books WHERE code = ${`late-now-${key}`} AND updated_at >= ${cursor}`;
      expect(missed).toEqual([]);
    } finally {
      if (!committed) await early`ROLLBACK`;
      early.release();
      await sql`DELETE FROM books WHERE code IN (${`cursor-now-${key}`}, ${`late-now-${key}`})`;
    }
  });
});
