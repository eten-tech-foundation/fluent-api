import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('upgrades 0041 to the empty unified artifact table without legacy lookup', async () => {
  const database = new PGlite();
  try {
    const [oldMigration, unifiedMigration] = await Promise.all(
      ['0041_assistant_artifacts.sql', '0042_assistant_artifacts.sql'].map((name) =>
        readFile(new URL(`./migrations/${name}`, import.meta.url), 'utf8')
      )
    );
    await database.exec(oldMigration);
    await database.query(
      `INSERT INTO assistant_briefing_artifacts (
        cache_key, markdown, operation_version, profile_version, resource_policy_version,
        cache_epoch, output_contract_version, response_language_hint, resource_language,
        source_language_code, expires_at
      ) VALUES ($1, $2, 'briefing-v1', 'profile-v1', 'resources-v1', '1', 'widgets-v1',
        'en', 'en', 'eng', CURRENT_TIMESTAMP + INTERVAL '1 day')`,
      ['a'.repeat(64), 'legacy markdown']
    );
    await database.exec(unifiedMigration);
    expect((await database.query('SELECT * FROM assistant_artifacts')).rows).toEqual([]);
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'assistant%artifacts'
       ORDER BY table_name`
    );
    expect(tables.rows).toEqual([{ table_name: 'assistant_artifacts' }]);
  } finally {
    await database.close();
  }
}, 30000);

it('applies the complete migration journal to a fresh PostgreSQL-compatible database', async () => {
  const database = new PGlite();
  try {
    await migrate(drizzle(database), {
      migrationsFolder: fileURLToPath(new URL('./migrations', import.meta.url)),
    });
    const { rows } = await database.query(
      `SELECT cache_key FROM assistant_artifacts WHERE expires_at > CURRENT_TIMESTAMP`
    );
    expect(rows).toEqual([]);
    const columns = await database.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'assistant_artifacts' ORDER BY ordinal_position`
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'cache_key',
      'markdown',
      'cache_epoch',
      'output_contract_version',
      'completed_at',
      'expires_at',
    ]);
  } finally {
    await database.close();
  }
}, 60000);
