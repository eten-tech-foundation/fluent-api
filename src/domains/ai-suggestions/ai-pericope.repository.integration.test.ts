import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as schema from '@/db/schema';

import {
  logPericopeUsage,
  resolvePericopes,
  savePericopeSuggestion,
} from './ai-pericope.repository';
import { logAiSuggestionUsage } from './ai-suggestions.repository';

// Opt-in only. Never connect to the developer's configured/shared database.
const { connection } = vi.hoisted(() => ({
  connection: { close: undefined as (() => Promise<void>) | undefined },
}));
vi.mock('@/db', async () => {
  const url = process.env.PERICOPE_TEST_DATABASE_URL;
  if (!url) return { db: {} };
  const target = new URL(url);
  if (
    target.hostname !== '127.0.0.1' ||
    target.port !== '55494' ||
    target.pathname !== '/fluent394_api'
  ) {
    throw new Error(
      'Pericope integration tests require the isolated fluent394_api database on localhost:55494'
    );
  }
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const client = postgres(url, { max: 2, onnotice: () => {} });
  connection.close = () => client.end();
  return { db: drizzle(client) };
});

describe.skipIf(!process.env.PERICOPE_TEST_DATABASE_URL)(
  'pericope repository with migrated PostgreSQL',
  () => {
    let projectUnitId: number;
    let projectId: number;
    let bibleId: number;
    let bookId: number;
    let pericopeSetId: number;
    let otherSetId: number;
    let userId: number;
    let bibleTextIds: number[];
    const query = () => ({
      projectUnitId,
      bibleId,
      bookCode: 'GEN',
      chapterNumber: 1,
      pericopeNumbers: ['4a', '4b'],
    });
    const heading = () => ({
      projectUnitId,
      bibleTextId: bibleTextIds[0],
      pericopeSetId,
      pericopeNumber: '4a',
      suggestedText: 'The creation',
      modelInfo: 'test-model',
    });

    beforeAll(async () => {
      await migrate(db, { migrationsFolder: './src/db/migrations' });
      const suffix = Date.now().toString();
      const [org] = await db
        .insert(schema.organizations)
        .values({ name: `Pericope test ${suffix}` })
        .returning();
      const [language] = await db
        .insert(schema.languages)
        .values({ langName: `Test ${suffix}` })
        .returning();
      const [user] = await db
        .insert(schema.users)
        .values({ username: `pericope-${suffix}`, email: `${suffix}@example.test` })
        .returning();
      userId = user.id;
      const sets = await db
        .insert(schema.pericope_sets)
        .values([{ name: `FIA-${suffix}` }, { name: `FCBH-${suffix}` }])
        .returning();
      pericopeSetId = sets[0].id;
      otherSetId = sets[1].id;
      const [project] = await db
        .insert(schema.projects)
        .values({
          name: 'Pericope test',
          sourceLanguage: language.id,
          targetLanguage: language.id,
          organization: org.id,
          pericopeSetId,
        })
        .returning();
      projectId = project.id;
      const [unit] = await db.insert(schema.project_units).values({ projectId }).returning();
      projectUnitId = unit.id;
      const [bible] = await db
        .insert(schema.bibles)
        .values({ languageId: language.id, name: `Source ${suffix}`, abbreviation: `s-${suffix}` })
        .returning();
      bibleId = bible.id;
      await db
        .insert(schema.books)
        .values({ code: 'GEN', eng_display_name: 'Genesis' })
        .onConflictDoNothing();
      const [book] = await db.select().from(schema.books).where(eq(schema.books.code, 'GEN'));
      bookId = book.id;
      await db.insert(schema.project_unit_bible_books).values({ projectUnitId, bibleId, bookId });
      await db
        .insert(schema.chapter_assignments)
        .values({ projectUnitId, bibleId, bookId, chapterNumber: 1, isAiEnabled: true });
      const texts = await db
        .insert(schema.bible_texts)
        .values(
          [1, 2, 3, 4].map((verseNumber) => ({
            bibleId,
            bookId,
            chapterNumber: 1,
            verseNumber,
            text: `Source ${verseNumber}`,
          }))
        )
        .returning();
      bibleTextIds = texts.map((text) => text.id);
      await db.insert(schema.pericope_verses).values(
        [pericopeSetId, otherSetId].flatMap((setId) =>
          [1, 2, 3, 4].map((verseNumber) => ({
            pericopeSetId: setId,
            bookId,
            chapterNumber: 1,
            verseNumber,
            section: setId === pericopeSetId ? null : verseNumber < 4 ? 1 : 2,
            pericopeNumber: setId === otherSetId || verseNumber < 4 ? '4a' : '4b',
            pericopeTitle: setId === pericopeSetId && verseNumber < 4 ? 'Creation' : null,
          }))
        )
      );
      await db.insert(schema.translated_verses).values([
        { projectUnitId, bibleTextId: bibleTextIds[1], content: '' },
        {
          projectUnitId,
          bibleTextId: bibleTextIds[2],
          content: 'Already translated',
          markers: { headings: [{ marker: 's', text: 'An authored heading' }] },
        },
      ]);
      await db
        .insert(schema.ai_suggestions)
        .values({ projectUnitId, bibleTextId: bibleTextIds[3], suggestedText: 'Cached scripture' });
    });
    afterAll(async () => {
      await connection.close?.();
    });

    it('resolves exact source IDs including absent and empty translation rows, and excludes unrelated contexts', async () => {
      const result = await resolvePericopes(query());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.groups[0].verses).toEqual([
        {
          bibleTextId: bibleTextIds[0],
          verseNumber: 1,
          content: null,
          hasAuthoredHeading: false,
          hasSuggestion: false,
        },
        {
          bibleTextId: bibleTextIds[1],
          verseNumber: 2,
          content: '',
          hasAuthoredHeading: false,
          hasSuggestion: false,
        },
        {
          bibleTextId: bibleTextIds[2],
          verseNumber: 3,
          content: 'Already translated',
          hasAuthoredHeading: true,
          hasSuggestion: false,
        },
      ]);
      expect(result.data.groups[1].sourceTitle).toBeNull();
      expect(result.data.groups[1].verses[0].hasSuggestion).toBe(true);
      for (const overrides of [
        { bibleId: bibleId + 9999 },
        { projectUnitId: projectUnitId + 9999 },
        { bookCode: 'EXO' },
        { chapterNumber: 2 },
        { pericopeNumbers: ['4a', 'missing'] },
      ]) {
        expect((await resolvePericopes({ ...query(), ...overrides })).ok).toBe(false);
      }
    });

    it('caches titles once, records shown then used without downgrade, and rejects mismatched usage', async () => {
      expect((await savePericopeSuggestion(heading())).ok).toBe(true);
      await savePericopeSuggestion({ ...heading(), suggestedText: 'Should not replace cache' });
      const usage = {
        projectUnitId,
        bibleTextId: bibleTextIds[0],
        pericopeNumber: '4a',
        wasUsed: false,
      };
      expect((await logPericopeUsage(userId, usage)).ok).toBe(true);
      expect((await logPericopeUsage(userId, { ...usage, wasUsed: true })).ok).toBe(true);
      await logPericopeUsage(userId, usage);
      const rows = await db
        .select()
        .from(schema.ai_pericope_suggestions)
        .where(eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId));
      expect(rows).toHaveLength(1);
      expect(rows[0].suggestedText).toBe('The creation');
      const exposures = await db
        .select()
        .from(schema.ai_pericope_suggestion_usage)
        .where(eq(schema.ai_pericope_suggestion_usage.suggestionId, rows[0].id));
      expect(exposures).toHaveLength(1);
      expect(exposures[0].wasUsed).toBe(true);
      expect((await logPericopeUsage(userId, { ...usage, bibleTextId: bibleTextIds[1] })).ok).toBe(
        false
      );
      expect((await logPericopeUsage(userId, { ...usage, pericopeNumber: '4b' })).ok).toBe(false);
      expect(
        await db
          .select()
          .from(schema.ai_suggestion_usage_log)
          .where(eq(schema.ai_suggestion_usage_log.projectUnitId, projectUnitId))
      ).toHaveLength(0);
      const scripture = await db
        .select()
        .from(schema.translated_verses)
        .where(eq(schema.translated_verses.projectUnitId, projectUnitId));
      expect(scripture.map((row) => row.content)).toEqual(['', 'Already translated']);
      expect(scripture[1].markers?.headings?.[0].text).toBe('An authored heading');
    });

    it('ignores title-less groups and authored headings, rejects mismatched first verse and old-set results', async () => {
      expect(
        (await savePericopeSuggestion({ ...heading(), bibleTextId: bibleTextIds[1] })).ok
      ).toBe(false);
      expect(
        (
          await savePericopeSuggestion({
            ...heading(),
            bibleTextId: bibleTextIds[3],
            pericopeNumber: '4b',
          })
        ).ok
      ).toBe(true);
      await db
        .delete(schema.ai_pericope_suggestions)
        .where(eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId));
      await db.insert(schema.translated_verses).values({
        projectUnitId,
        bibleTextId: bibleTextIds[0],
        content: '',
        markers: { headings: [{ marker: 's1', text: 'Written while generating' }] },
      });
      expect((await savePericopeSuggestion(heading())).ok).toBe(true);
      expect(
        await db
          .select()
          .from(schema.ai_pericope_suggestions)
          .where(eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId))
      ).toHaveLength(0);
      await db
        .update(schema.translated_verses)
        .set({ markers: null })
        .where(
          and(
            eq(schema.translated_verses.projectUnitId, projectUnitId),
            eq(schema.translated_verses.bibleTextId, bibleTextIds[0])
          )
        );
      await savePericopeSuggestion(heading());
      await db
        .update(schema.projects)
        .set({ pericopeSetId: otherSetId })
        .where(eq(schema.projects.id, projectId));
      expect((await savePericopeSuggestion(heading())).ok).toBe(false);
      const current = await resolvePericopes({ ...query(), pericopeNumbers: ['1_4a', '2_4a'] });
      expect(current.ok && current.data.groups[0].suggestion).toBeNull();
      expect(
        current.ok &&
          current.data.groups.map((group) => ({
            number: group.pericopeNumber,
            verses: group.verses.map((verse) => verse.verseNumber),
          }))
      ).toEqual([
        { number: '1_4a', verses: [1, 2, 3] },
        { number: '2_4a', verses: [4] },
      ]);
      expect((await resolvePericopes(query())).ok).toBe(false);
      expect(
        (
          await logPericopeUsage(userId, {
            projectUnitId,
            bibleTextId: bibleTextIds[0],
            pericopeNumber: '4a',
            wasUsed: false,
          })
        ).ok
      ).toBe(false);
    });

    it('also keeps existing verse acceptance after a delayed exposure event', async () => {
      await logAiSuggestionUsage(userId, bibleTextIds[3], projectUnitId, false);
      await logAiSuggestionUsage(userId, bibleTextIds[3], projectUnitId, true);
      await logAiSuggestionUsage(userId, bibleTextIds[3], projectUnitId, false);
      const records = await db
        .select()
        .from(schema.ai_suggestion_usage_log)
        .where(
          and(
            eq(schema.ai_suggestion_usage_log.projectUnitId, projectUnitId),
            eq(schema.ai_suggestion_usage_log.userId, userId)
          )
        );
      expect(records).toHaveLength(1);
      expect(records[0].wasUsed).toBe(true);
    });
  }
);
