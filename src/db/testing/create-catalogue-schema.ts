import type { PGlite } from '@electric-sql/pglite';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalogue_watermark } from '../schema';

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Split a Drizzle SQL migration file on statement breakpoints. */
export function migrationStatements(fileName: string): string[] {
  return readFileSync(join(migrationDir, fileName), 'utf8')
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** DROP/CREATE for the provider-resource → bibles watermark trigger (single source). */
export const PROVIDER_RESOURCE_LICENSE_TRIGGER_SQL = `
    DROP TRIGGER IF EXISTS trg_bump_bibles_on_provider_resource_license ON bible_provider_resources;
    CREATE TRIGGER trg_bump_bibles_on_provider_resource_license
    AFTER INSERT OR UPDATE OF tts_license_status, license_notice, display_name, provider, external_id
    ON bible_provider_resources
    FOR EACH ROW
    EXECUTE FUNCTION bump_linked_bibles_on_provider_resource_license();
  `;

/** Install next_catalogue_watermark() before CREATE TABLE … DEFAULT that references it. */
export async function installNextCatalogueWatermarkFunction(
  client: Pick<PGlite, 'exec'>
): Promise<void> {
  const allocator = migrationStatements('0038_catalogue_watermark_allocator.sql').find(
    (statement) => statement.includes('CREATE FUNCTION next_catalogue_watermark()')
  );
  if (!allocator) throw new Error('Catalogue allocator migration is missing');
  await client.exec(allocator);
}

/** Seed the singleton after catalogue_watermark exists (schema gen or migration). */
export async function seedCatalogueWatermarkSingleton(client: Pick<PGlite, 'exec'>): Promise<void> {
  await client.exec(`INSERT INTO catalogue_watermark (id, updated_at)
    VALUES (true, clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT (id) DO NOTHING`);
}

/**
 * Install next_catalogue_watermark() then generate catalogue tables whose
 * DEFAULT / $onUpdate expressions reference it (PGlite watermark suite helper).
 */
export async function createCatalogueTestSchema(
  client: PGlite,
  tables: Parameters<typeof generateDrizzleJson>[0]
) {
  await installNextCatalogueWatermarkFunction(client);
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson({ ...tables, catalogue_watermark })
  );
  await client.exec(statements.join('\n'));
  await seedCatalogueWatermarkSingleton(client);

  const bump = migrationStatements('0038_catalogue_watermark_allocator.sql').find((statement) =>
    statement.includes('CREATE OR REPLACE FUNCTION bump_linked_bibles_on_provider_resource_license')
  );
  if (!bump) throw new Error('Catalogue license-bump trigger migration is missing');
  await client.exec(bump);
  await client.exec(PROVIDER_RESOURCE_LICENSE_TRIGGER_SQL);
}
