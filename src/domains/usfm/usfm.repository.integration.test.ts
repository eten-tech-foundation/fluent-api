import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { setupPericopeIntegrationTest } from '@/domains/ai-suggestions/ai-pericope.test-fixtures';
import { ok } from '@/lib/types';

import { getAvailableBooksForExport } from './usfm.repository';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }));

// The fixture's GEN 1 has four verses: no row, a row with no words, a draft and a verse with only
// an AI suggestion.
describe('export book list with real PostgreSQL queries', () => {
  let fixture: Awaited<ReturnType<typeof setupPericopeIntegrationTest>>;

  beforeAll(async () => {
    fixture = await setupPericopeIntegrationTest(client, db);
    // What a USFM import stores for a verse that opens a paragraph and has no words yet.
    await db
      .update(schema.translated_verses)
      .set({ markers: { paragraphs: [{ marker: 'p', offset: 0 }] } })
      .where(
        and(
          eq(schema.translated_verses.projectUnitId, fixture.projectUnitId),
          eq(schema.translated_verses.bibleTextId, fixture.bibleTextIds[1])
        )
      );
  }, 30_000);
  afterAll(async () => {
    await client.close();
  });

  it('counts only rows with words as translated', async () => {
    const result = await getAvailableBooksForExport(fixture.projectUnitId);

    expect(result).toEqual(
      ok([
        {
          bookId: fixture.bookId,
          bookCode: 'GEN',
          bookName: 'Genesis',
          verseCount: 4,
          translatedCount: 1,
        },
      ])
    );
  });
});
