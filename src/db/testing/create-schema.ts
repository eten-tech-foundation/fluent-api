import type { PGlite } from '@electric-sql/pglite';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { readFileSync } from 'node:fs';

import { catalogue_watermark } from '../schema';

/** Generate a test schema with the SQL function required by catalogue defaults. */
export async function createTestSchema(
  client: PGlite,
  tables: Parameters<typeof generateDrizzleJson>[0]
) {
  const migration = readFileSync(
    new URL('../migrations/0034_add_books_timestamps.sql', import.meta.url),
    'utf8'
  );
  const allocator = migration
    .split('--> statement-breakpoint')
    .find((statement) => statement.includes('CREATE FUNCTION next_catalogue_watermark()'));
  if (!allocator) throw new Error('Catalogue allocator migration is missing');
  // PL/pgSQL resolves table references on execution, so install the function
  // before generating tables whose DEFAULT expressions reference it.
  await client.exec(allocator);
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ ...tables, catalogue_watermark })
  );
  await client.exec(statements.join('\n'));
  await client.exec(`INSERT INTO catalogue_watermark (updated_at)
    VALUES (clock_timestamp() AT TIME ZONE 'UTC')`);
}
