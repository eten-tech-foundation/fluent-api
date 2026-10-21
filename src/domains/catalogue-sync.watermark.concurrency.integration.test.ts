import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Multi-session PostgreSQL regressions for #404. PGlite cannot exercise
 * competing transactions. Gated on WATERMARK_TEST_DATABASE_URL (never
 * DATABASE_URL / shared Dev/QA). Pattern mirrors dlq-integration.
 */
const connectionString = process.env.WATERMARK_TEST_DATABASE_URL;
const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../db/migrations');

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

    const statements = readFileSync(
      join(migrationDir, '0038_catalogue_watermark_allocator.sql'),
      'utf8'
    )
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    await sql.unsafe(`
        DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
        CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
        AFTER INSERT OR UPDATE OF tts_license_status, license_notice, display_name, provider, external_id
        ON bible_provider_resources
        FOR EACH ROW
        EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
      `);
  }, 60_000);

  afterAll(async () => {
    await sql.end();
  });

  it.each(['book insert', 'Bible update', 'language fill', 'license trigger'] as const)(
    '%s cannot be lost when a cursor advances during a transaction',
    async (operation) => {
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
        let changed: { updated_at: Date } | undefined;
        if (operation === 'book insert') {
          [changed] = await early`
              INSERT INTO books (code, eng_display_name) VALUES (${key}, 'Late book')
              RETURNING updated_at`;
        } else if (operation === 'Bible update') {
          [changed] = await early`
              UPDATE bibles SET has_audio = true, updated_at = next_catalogue_watermark()
              WHERE id = ${bible!.id} RETURNING updated_at`;
        } else if (operation === 'language fill') {
          [changed] = await early`
              UPDATE languages SET lang_name_localized = 'Filled', updated_at = next_catalogue_watermark()
              WHERE id = ${language!.id} RETURNING updated_at`;
        } else {
          await early`
              UPDATE bible_provider_resources SET tts_license_status = 'allowed'
              WHERE id = ${resource!.id}`;
          [changed] = await early`SELECT updated_at FROM bibles WHERE id = ${bible!.id}`;
        }
        expect(changed!.updated_at.getTime()).toBeGreaterThan(cursor.getTime());

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
        expect((newer!.updated_at as Date).getTime()).toBeGreaterThan(
          changed!.updated_at.getTime()
        );
        const table =
          operation === 'book insert'
            ? 'books'
            : operation === 'language fill'
              ? 'languages'
              : 'bibles';
        const rows = await sql`SELECT updated_at FROM ${sql(table)} WHERE updated_at >= ${cursor}`;
        expect(rows.map((row) => (row.updated_at as Date).getTime())).toContain(
          changed!.updated_at.getTime()
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

  it('documents that now()-stamped writes can fall behind a concurrent cursor', async () => {
    // Regression baseline: same race with an explicit now() stamp (no allocator
    // lock). The late-commit row can land behind the cursor issued mid-flight.
    const key = randomUUID();
    const early = await sql.reserve();
    let committed = false;
    try {
      await early`BEGIN`;
      // Hold the early transaction open without taking the catalogue lock.
      await early`SELECT 1`;
      const [cursorRow] = await sql`
          INSERT INTO books (code, eng_display_name)
          VALUES (${`cursor-now-${key}`}, 'Cursor')
          RETURNING updated_at`;
      const cursor = cursorRow!.updated_at as Date;
      // Force a wall-clock stamp older than the concurrent cursor.
      const [changed] = await early`
          INSERT INTO books (code, eng_display_name, updated_at)
          VALUES (${`late-now-${key}`}, 'Late', ${new Date(cursor.getTime() - 5)})
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
