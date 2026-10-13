import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

// Run with test:db against the migrated local database. PGlite cannot exercise
// competing transactions: these checks need independent PostgreSQL sessions.
const sql = postgres(process.env.DATABASE_URL!, { max: 3 });
afterAll(() => sql.end());

describe('catalogue watermark commit ordering (PostgreSQL)', () => {
  it.each(['book insert', 'Bible update', 'language fill', 'license trigger'])(
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
        const cursor = cursorRow!.updated_at;
        let changed;
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
        // commit a cursor that would skip the in-flight row. Observe the actual
        // database lock wait instead of relying on a timing-only assertion.
        const [connection] = await later`SELECT pg_backend_pid() AS pid`;
        pending = later`
          INSERT INTO books (code, eng_display_name) VALUES (${`later-${key}`}, 'Later')
          RETURNING updated_at`.execute();
        await expect
          .poll(async () => {
            const [state] =
              await sql`SELECT cardinality(pg_blocking_pids(${connection!.pid})) AS count`;
            return state!.count;
          })
          .toBeGreaterThan(0);
        await early`COMMIT`;
        committed = true;
        const [newer] = await pending;
        expect(newer!.updated_at.getTime()).toBeGreaterThan(changed!.updated_at.getTime());
        const table =
          operation === 'book insert'
            ? 'books'
            : operation === 'language fill'
              ? 'languages'
              : 'bibles';
        const rows = await sql`SELECT updated_at FROM ${sql(table)} WHERE updated_at >= ${cursor}`;
        expect(rows.map((row) => row.updated_at.getTime())).toContain(
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
});
