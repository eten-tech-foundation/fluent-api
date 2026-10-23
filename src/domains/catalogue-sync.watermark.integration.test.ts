import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createCatalogueTestSchema } from '@/db/testing/create-catalogue-schema';
import * as biblesRepo from '@/domains/bibles/bibles.repository';

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

describe('catalogue sync watermarks (PGlite)', () => {
  beforeAll(async () => {
    await createCatalogueTestSchema(client, {
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

  describe('provider-resource license trigger (DB boundary)', () => {
    it('bumps text-linked bibles on real license INSERT', async () => {
      const [language] = await database
        .insert(schema.languages)
        .values({ langName: 'English', langCodeIso6393: 'eng' })
        .returning();
      const [bible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Preexisting',
          abbreviation: 'PRE',
          provider: 'dbl',
          externalId: 'text-insert',
        })
        .returning();
      const before = bible!.updatedAt!;
      await new Promise((resolve) => setTimeout(resolve, 5));

      await database.insert(schema.bible_provider_resources).values({
        provider: 'dbl',
        externalId: 'text-insert',
        ttsLicenseStatus: 'allowed',
        licenseNotice: 'notice',
      });

      const [after] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, bible!.id));
      expect(after!.updatedAt!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('bumps text-linked and audio-linked bibles on real license UPDATE', async () => {
      const [language] = await database
        .insert(schema.languages)
        .values({ langName: 'English', langCodeIso6393: 'eng' })
        .returning();
      const [text] = await database
        .insert(schema.bible_provider_resources)
        .values({
          provider: 'dbl',
          externalId: 'text-1',
          ttsLicenseStatus: 'allowed',
          licenseNotice: 'notice',
        })
        .returning();
      const [audio] = await database
        .insert(schema.bible_provider_resources)
        .values({
          provider: 'aquifer',
          externalId: 'rec-1',
          ttsLicenseStatus: 'allowed',
        })
        .returning();
      const [textBible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Text Linked',
          abbreviation: 'TXT',
          provider: 'dbl',
          externalId: 'text-1',
        })
        .returning();
      const [audioBible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Audio Linked',
          abbreviation: 'AUD',
          provider: 'dbl',
          externalId: 'other-text',
          audioResourceId: audio!.id,
        })
        .returning();

      const textBefore = textBible!.updatedAt!;
      const audioBefore = audioBible!.updatedAt!;
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Ordinary ORM UPDATE — DB trigger is the invariant (no app writer required).
      await database
        .update(schema.bible_provider_resources)
        .set({ ttsLicenseStatus: 'forbidden' })
        .where(eq(schema.bible_provider_resources.id, text!.id));
      await database
        .update(schema.bible_provider_resources)
        .set({ licenseNotice: 'updated notice' })
        .where(eq(schema.bible_provider_resources.id, audio!.id));

      const [textAfter] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, textBible!.id));
      const [audioAfter] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, audioBible!.id));
      expect(textAfter!.updatedAt!.getTime()).toBeGreaterThan(textBefore.getTime());
      expect(audioAfter!.updatedAt!.getTime()).toBeGreaterThan(audioBefore.getTime());

      const filtered = await biblesRepo.getAll(textBefore);
      expect(filtered.ok).toBe(true);
      if (filtered.ok) {
        expect(filtered.data.map((row) => row.id).sort()).toEqual(
          [textBible!.id, audioBible!.id].sort()
        );
      }
    });

    it.each(['externalId', 'provider', 'displayName'] as const)(
      'bumps all affected bibles when %s changes',
      async (field) => {
        const [language] = await database
          .insert(schema.languages)
          .values({ langName: 'English' })
          .returning();
        const [resource] = await database
          .insert(schema.bible_provider_resources)
          .values({
            provider: 'dbl',
            externalId: 'old-text',
            displayName: 'Old label',
          })
          .returning();
        const linked = await database
          .insert(schema.bibles)
          .values([
            { languageId: language!.id, name: 'Old', abbreviation: 'OLD', externalId: 'old-text' },
            { languageId: language!.id, name: 'New', abbreviation: 'NEW', externalId: 'new-text' },
            {
              languageId: language!.id,
              name: 'Audio',
              abbreviation: 'AUD',
              audioResourceId: resource!.id,
            },
            {
              languageId: language!.id,
              name: 'Unrelated',
              abbreviation: 'NON',
              externalId: 'unrelated',
            },
          ])
          .returning();
        const change =
          field === 'externalId'
            ? { externalId: 'new-text' }
            : field === 'provider'
              ? { provider: 'aquifer' as const }
              : { displayName: 'New label' };
        // `now()` is millisecond-resolution; wait so the trigger stamp advances.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await database
          .update(schema.bible_provider_resources)
          .set(change)
          .where(eq(schema.bible_provider_resources.id, resource!.id));
        const after = await database.select().from(schema.bibles);
        for (const before of linked) {
          const updated = after.find((row) => row.id === before.id)!;
          const shouldBump =
            before.abbreviation === 'OLD' ||
            before.abbreviation === 'AUD' ||
            (field === 'externalId' && before.abbreviation === 'NEW');
          if (shouldBump)
            expect(updated.updatedAt!.getTime()).toBeGreaterThan(before.updatedAt!.getTime());
          else expect(updated.updatedAt).toEqual(before.updatedAt);
        }
        // Repeating the same identity/display update is a no-op.
        await database
          .update(schema.bible_provider_resources)
          .set(change)
          .where(eq(schema.bible_provider_resources.id, resource!.id));
        expect(await database.select().from(schema.bibles)).toEqual(after);
        if (field === 'provider') {
          // Moving back into DBL also invalidates the new text identity.
          await database
            .update(schema.bible_provider_resources)
            .set({ provider: 'dbl' })
            .where(eq(schema.bible_provider_resources.id, resource!.id));
          const [restored] = await database
            .select()
            .from(schema.bibles)
            .where(eq(schema.bibles.abbreviation, 'OLD'));
          expect(restored!.updatedAt!.getTime()).toBeGreaterThan(
            after.find((row) => row.abbreviation === 'OLD')!.updatedAt!.getTime()
          );
        }
      }
    );

    it('does not bump on unchanged license UPDATE', async () => {
      const [language] = await database
        .insert(schema.languages)
        .values({ langName: 'English', langCodeIso6393: 'eng' })
        .returning();
      const [text] = await database
        .insert(schema.bible_provider_resources)
        .values({
          provider: 'dbl',
          externalId: 'text-noop',
          ttsLicenseStatus: 'allowed',
        })
        .returning();
      const [bible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Noop Bible',
          abbreviation: 'NOP',
          provider: 'dbl',
          externalId: 'text-noop',
        })
        .returning();
      const before = bible!.updatedAt!;

      await database
        .update(schema.bible_provider_resources)
        .set({ ttsLicenseStatus: 'allowed' })
        .where(eq(schema.bible_provider_resources.id, text!.id));

      const [after] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, bible!.id));
      expect(after!.updatedAt!.getTime()).toBe(before.getTime());
    });

    it('selected-recording change via bibles.audio_resource_id advances via $onUpdate', async () => {
      const [language] = await database
        .insert(schema.languages)
        .values({ langName: 'English', langCodeIso6393: 'eng' })
        .returning();
      const [audioA] = await database
        .insert(schema.bible_provider_resources)
        .values({ provider: 'aquifer', externalId: 'a', ttsLicenseStatus: 'allowed' })
        .returning();
      const [audioB] = await database
        .insert(schema.bible_provider_resources)
        .values({ provider: 'aquifer', externalId: 'b', ttsLicenseStatus: 'allowed' })
        .returning();
      const [bible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Recording Bible',
          abbreviation: 'REC',
          provider: 'dbl',
          externalId: 'rec-text',
          audioResourceId: audioA!.id,
        })
        .returning();
      const before = bible!.updatedAt!;
      await new Promise((resolve) => setTimeout(resolve, 5));

      // selectedRecordingKey is derived from bibles.audio_resource_id; that column
      // lives on bibles and already advances updated_at via drizzle $onUpdate.
      await database
        .update(schema.bibles)
        .set({ audioResourceId: audioB!.id })
        .where(eq(schema.bibles.id, bible!.id));

      const [after] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, bible!.id));
      expect(after!.audioResourceId).toBe(audioB!.id);
      expect(after!.updatedAt!.getTime()).toBeGreaterThan(before.getTime());
    });

    it('rolls back linked-bible watermark when the license UPDATE transaction rolls back', async () => {
      const [language] = await database
        .insert(schema.languages)
        .values({ langName: 'English', langCodeIso6393: 'eng' })
        .returning();
      const [text] = await database
        .insert(schema.bible_provider_resources)
        .values({
          provider: 'dbl',
          externalId: 'text-rollback',
          ttsLicenseStatus: 'allowed',
        })
        .returning();
      const [bible] = await database
        .insert(schema.bibles)
        .values({
          languageId: language!.id,
          name: 'Rollback Bible',
          abbreviation: 'RBK',
          provider: 'dbl',
          externalId: 'text-rollback',
        })
        .returning();
      const before = bible!.updatedAt!;

      await expect(
        database.transaction(async (tx) => {
          await tx
            .update(schema.bible_provider_resources)
            .set({ ttsLicenseStatus: 'forbidden' })
            .where(eq(schema.bible_provider_resources.id, text!.id));
          throw new Error('force rollback');
        })
      ).rejects.toThrow('force rollback');

      const [resource] = await database
        .select()
        .from(schema.bible_provider_resources)
        .where(eq(schema.bible_provider_resources.id, text!.id));
      const [after] = await database
        .select()
        .from(schema.bibles)
        .where(eq(schema.bibles.id, bible!.id));
      expect(resource!.ttsLicenseStatus).toBe('allowed');
      expect(after!.updatedAt!.getTime()).toBe(before.getTime());
    });
  });
});
