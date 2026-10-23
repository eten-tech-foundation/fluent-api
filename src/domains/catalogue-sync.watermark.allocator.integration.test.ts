import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import * as booksRepo from '@/domains/books/books.repository';
import * as languagesRepo from '@/domains/languages/languages.repository';

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

describe('catalogue watermark allocator paths (PGlite)', () => {
  beforeAll(async () => {
    await createTestSchema(client, {
      languages: schema.languages,
      books: schema.books,
      bible_books: schema.bible_books,
      bible_provider_resources: schema.bible_provider_resources,
      bibles: schema.bibles,
      scriptDirectionEnum: schema.scriptDirectionEnum,
      bibleProviderEnum: schema.bibleProviderEnum,
      resourceProviderEnum: schema.resourceProviderEnum,
      ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
    });
    await client.exec("SET timezone = 'UTC';");
  }, 30_000);

  beforeEach(async () => {
    await database.delete(schema.bible_books);
    await database.delete(schema.bibles);
    await database.delete(schema.bible_provider_resources);
    await database.delete(schema.books);
    await database.delete(schema.languages);
  });

  afterAll(async () => {
    await client.close();
  });

  it('pins DEFAULT, $onUpdate, and upsert conflict arms past the wall clock', async () => {
    const future = new Date('2090-01-01T00:00:00.000Z');
    // Stamps from the allocator stay near `future`; wall-clock now()/new Date() would not.
    const fromAllocator = (stamp: Date) => {
      expect(stamp.getTime()).toBeGreaterThan(future.getTime());
      expect(stamp.getTime()).toBeLessThan(future.getTime() + 100);
    };

    await database.update(schema.catalogue_watermark).set({ updatedAt: future });
    await expect(
      database.transaction(async (tx) => {
        await tx.insert(schema.books).values({ code: 'ROLLBACK', eng_display_name: 'Rollback' });
        throw new Error('rollback');
      })
    ).rejects.toThrow('rollback');
    const [state] = await database.select().from(schema.catalogue_watermark);
    expect(state!.updatedAt).toEqual(future);

    // Column DEFAULT
    const [inserted] = await database
      .insert(schema.books)
      .values({ code: 'A', eng_display_name: 'A' })
      .returning();
    expect(inserted!.updatedAt!.getTime()).toBe(future.getTime() + 1);

    // ORM .update() → $onUpdate (not bare now()/new Date())
    const [ormUpdated] = await database
      .update(schema.books)
      .set({ eng_display_name: 'A2' })
      .where(eq(schema.books.id, inserted!.id))
      .returning();
    expect(ormUpdated!.updatedAt!.getTime()).toBe(future.getTime() + 2);

    // languages upsert conflict arm
    await database.insert(schema.languages).values({
      langName: 'Spanish',
      langCodeIso6393: 'spa',
      langNameLocalized: null,
      scriptDirection: 'ltr',
    });
    const langFill = await languagesRepo.upsertFromDbl([
      {
        langCodeIso6393: 'spa',
        langName: 'Español',
        langNameLocalized: 'Español',
        scriptDirection: 'ltr',
      },
    ]);
    expect(langFill.ok).toBe(true);
    const [langAfter] = await database
      .select()
      .from(schema.languages)
      .where(eq(schema.languages.langCodeIso6393, 'spa'));
    expect(langAfter!.langNameLocalized).toBe('Español');
    fromAllocator(langAfter!.updatedAt!);
    expect(langAfter!.updatedAt!.getTime()).toBeGreaterThan(ormUpdated!.updatedAt!.getTime());

    // bibles upsert conflict arm
    const bibleInsert = await biblesRepo.upsertFromDbl([
      {
        languageId: langAfter!.id,
        name: 'Alpha',
        abbreviation: 'ALP',
        provider: 'dbl',
        externalId: 'alpha-future',
        hasAudio: false,
      },
    ]);
    expect(bibleInsert.ok).toBe(true);
    const bibleChange = await biblesRepo.upsertFromDbl([
      {
        languageId: langAfter!.id,
        name: 'Alpha',
        abbreviation: 'ALP',
        provider: 'dbl',
        externalId: 'alpha-future',
        hasAudio: true,
      },
    ]);
    expect(bibleChange.ok).toBe(true);
    const [bibleAfter] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.externalId, 'alpha-future'));
    expect(bibleAfter!.hasAudio).toBe(true);
    fromAllocator(bibleAfter!.updatedAt!);
    expect(bibleAfter!.updatedAt!.getTime()).toBeGreaterThan(langAfter!.updatedAt!.getTime());

    const incremental = await booksRepo.getAll(inserted!.updatedAt!);
    expect(incremental.ok).toBe(true);
    if (incremental.ok) {
      expect(incremental.data.map((row) => row.code)).toEqual(['A']);
    }
  });

  it('books upsert does not stamp updatedAt on unchanged re-sync but still links', async () => {
    const [language] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();
    const [bible] = await database
      .insert(schema.bibles)
      .values({
        languageId: language!.id,
        name: 'Link Bible',
        abbreviation: 'LNK',
        provider: 'dbl',
        externalId: 'link-1',
      })
      .returning();

    const first = await booksRepo.upsertFromDbl(bible!.id, [
      { code: 'GEN', eng_display_name: 'Genesis' },
    ]);
    expect(first.ok).toBe(true);

    const [bookAfterInsert] = await database
      .select()
      .from(schema.books)
      .where(eq(schema.books.code, 'GEN'));
    const watermark = bookAfterInsert!.updatedAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await booksRepo.upsertFromDbl(bible!.id, [
      { code: 'GEN', eng_display_name: 'Génesis' },
    ]);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.linkedBooks).toBe(1);

    const [bookAfterNoop] = await database
      .select()
      .from(schema.books)
      .where(eq(schema.books.code, 'GEN'));
    expect(bookAfterNoop!.eng_display_name).toBe('Genesis');
    expect(bookAfterNoop!.updatedAt!.getTime()).toBe(watermark!.getTime());
  });

  it('languages upsert stamps updatedAt only when COALESCE fills a NULL', async () => {
    await database.insert(schema.languages).values({
      langName: 'Spanish',
      langCodeIso6393: 'spa',
      langNameLocalized: null,
      scriptDirection: 'ltr',
    });
    const [before] = await database
      .select()
      .from(schema.languages)
      .where(eq(schema.languages.langCodeIso6393, 'spa'));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await languagesRepo.upsertFromDbl([
      {
        langCodeIso6393: 'spa',
        langName: 'Español',
        langNameLocalized: null,
        scriptDirection: 'ltr',
      },
    ]);
    const [afterNoop] = await database
      .select()
      .from(schema.languages)
      .where(eq(schema.languages.langCodeIso6393, 'spa'));
    expect(afterNoop!.langName).toBe('Spanish');
    expect(afterNoop!.updatedAt!.getTime()).toBe(before!.updatedAt!.getTime());

    await new Promise((resolve) => setTimeout(resolve, 5));
    await languagesRepo.upsertFromDbl([
      {
        langCodeIso6393: 'spa',
        langName: 'Español',
        langNameLocalized: 'Español',
        scriptDirection: 'ltr',
      },
    ]);
    const [afterFill] = await database
      .select()
      .from(schema.languages)
      .where(eq(schema.languages.langCodeIso6393, 'spa'));
    expect(afterFill!.langNameLocalized).toBe('Español');
    expect(afterFill!.updatedAt!.getTime()).toBeGreaterThan(before!.updatedAt!.getTime());
  });

  it('bibles upsert stamps updatedAt only when a tracked column changes', async () => {
    const [language] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();

    await biblesRepo.upsertFromDbl([
      {
        languageId: language!.id,
        name: 'Alpha',
        abbreviation: 'ALP',
        provider: 'dbl',
        externalId: 'alpha-1',
        hasAudio: false,
      },
    ]);
    const [before] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.externalId, 'alpha-1'));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await biblesRepo.upsertFromDbl([
      {
        languageId: language!.id,
        name: 'Alpha',
        abbreviation: 'ALP',
        provider: 'dbl',
        externalId: 'alpha-1',
        hasAudio: false,
      },
    ]);
    const [afterNoop] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.externalId, 'alpha-1'));
    expect(afterNoop!.updatedAt!.getTime()).toBe(before!.updatedAt!.getTime());

    await new Promise((resolve) => setTimeout(resolve, 5));
    await biblesRepo.upsertFromDbl([
      {
        languageId: language!.id,
        name: 'Alpha',
        abbreviation: 'ALP',
        provider: 'dbl',
        externalId: 'alpha-1',
        hasAudio: true,
      },
    ]);
    const [afterChange] = await database
      .select()
      .from(schema.bibles)
      .where(eq(schema.bibles.externalId, 'alpha-1'));
    expect(afterChange!.hasAudio).toBe(true);
    expect(afterChange!.updatedAt!.getTime()).toBeGreaterThan(before!.updatedAt!.getTime());
  });
});
