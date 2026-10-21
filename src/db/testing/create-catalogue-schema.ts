import type { PGlite } from '@electric-sql/pglite';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogue_watermark } from '../schema';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

function migrationStatements(fileName: string): string[] {
  return readFileSync(join(migrationDir, fileName), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/**
 * Install next_catalogue_watermark() then generate catalogue tables whose
 * DEFAULT / $onUpdate expressions reference it (PGlite test helper).
 */
export async function createCatalogueTestSchema(
  client: PGlite,
  tables: Parameters<typeof generateDrizzleJson>[0]
) {
  const allocator = migrationStatements('0038_catalogue_watermark_allocator.sql').find(
    (statement) => statement.includes('CREATE FUNCTION next_catalogue_watermark()')
  );
  if (!allocator) throw new Error('Catalogue allocator migration is missing');

  // PL/pgSQL resolves table references on execution, so install the function
  // before generating tables whose DEFAULT expressions reference it.
  await client.exec(allocator);
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ ...tables, catalogue_watermark })
  );
  await client.exec(statements.join('\n'));
  await client.exec(`INSERT INTO catalogue_watermark (id, updated_at)
    VALUES (true, clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT (id) DO NOTHING`);

  const bump = migrationStatements('0038_catalogue_watermark_allocator.sql').find((statement) =>
    statement.includes('CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license')
  );
  if (!bump) throw new Error('Catalogue license-bump trigger migration is missing');
  await client.exec(bump);

  // Recreate the trigger the same way production 0037/0038 do.
  await client.exec(`
    DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
    CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
    AFTER INSERT OR UPDATE OF tts_license_status, license_notice, display_name, provider, external_id
    ON bible_provider_resources
    FOR EACH ROW
    EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
  `);
}
