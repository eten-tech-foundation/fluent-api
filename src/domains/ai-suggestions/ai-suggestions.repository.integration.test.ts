import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as schema from '@/db/schema';

import { setupPericopeIntegrationTest } from './ai-pericope.test-fixtures';
import {
  findNextUntranslatedVerses,
  findVersesNeedingSuggestions,
} from './ai-suggestions.repository';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), debug: vi.fn() } }));

// The fixture's GEN 1: verse 1 has no row, verse 2 a row with no words, verse 3 a draft and
// verse 4 a cached suggestion.
describe('suggestion look-ahead with real PostgreSQL queries', () => {
  let fixture: Awaited<ReturnType<typeof setupPericopeIntegrationTest>>;

  beforeAll(async () => {
    fixture = await setupPericopeIntegrationTest(client, db);
    // What a USFM import stores for a verse that opens a poetry line and has no words yet.
    await db
      .update(schema.translated_verses)
      .set({ markers: { paragraphs: [{ marker: 'q1', offset: 0 }] } })
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

  it('looks ahead to a verse whose row has no words', async () => {
    const verses = await findNextUntranslatedVerses(
      fixture.projectUnitId,
      fixture.bibleId,
      'GEN',
      1,
      0,
      10
    );

    expect(verses).toEqual([1, 2]);
  });

  it('queues a suggestion for a verse whose row has no words', async () => {
    const verses = await findVersesNeedingSuggestions(
      fixture.projectUnitId,
      fixture.bibleId,
      'GEN',
      1,
      [1, 2, 3, 4]
    );

    expect(verses).toEqual([1, 2]);
  });
});
