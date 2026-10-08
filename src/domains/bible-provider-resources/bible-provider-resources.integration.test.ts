import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';

import { getByIds, getByProviderIdentities } from './bible-provider-resources.repository';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('bible provider resource batch queries', () => {
  beforeAll(async () => {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        bible_provider_resources: schema.bible_provider_resources,
        resourceProviderEnum: schema.resourceProviderEnum,
        ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      })
    );
    await client.exec(statements.join('\n'));
  }, 30_000);

  beforeEach(async () => {
    await database.delete(schema.bible_provider_resources);
    await database.insert(schema.bible_provider_resources).values([
      { id: 1, provider: 'dbl', externalId: 'shared', ttsLicenseStatus: 'allowed' },
      { id: 2, provider: 'aquifer', externalId: 'shared', ttsLicenseStatus: 'forbidden' },
      { id: 3, provider: 'dbl', externalId: 'other', ttsLicenseStatus: 'unknown' },
      { id: 4, provider: 'aquifer', externalId: 'other', ttsLicenseStatus: 'allowed' },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('matches only the exact requested provider/external-ID pairs', async () => {
    const result = await getByProviderIdentities([
      { provider: 'dbl', externalId: 'shared' },
      { provider: 'aquifer', externalId: 'other' },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map(({ id }) => id).sort()).toEqual([1, 4]);
  });

  it('returns only requested recording IDs without relying on database order', async () => {
    const result = await getByIds([4, 1]);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.map(({ id }) => id).sort()).toEqual([1, 4]);
  });
});
