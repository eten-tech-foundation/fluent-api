import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as schema from '@/db/schema';

import type { PericopeSuggestionItem, PericopeUsageRequest } from './ai-suggestions.types';

import { resolvePericopes } from './ai-pericope.repository';
import { logAiSuggestionUsage } from './ai-suggestions.repository';
import { saveAiSuggestions, trackPericopeUsage } from './ai-suggestions.service';

const savePericopeSuggestion = (item: PericopeSuggestionItem) => saveAiSuggestions([], item);
const logPericopeUsage = (id: number, data: PericopeUsageRequest) =>
  trackPericopeUsage({ id }, data);

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/env', () => ({ default: { AI_ACTIVATION_THRESHOLD_VERSES: 5 } }));
vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: { AI_SUGGESTIONS: 'ai-suggestions' },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), debug: vi.fn() } }));

describe('pericope repository with real PostgreSQL queries', () => {
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
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        ai_pericope_suggestion_usage: schema.ai_pericope_suggestion_usage,
        ai_pericope_suggestions: schema.ai_pericope_suggestions,
        ai_suggestions: schema.ai_suggestions,
        ai_suggestion_usage_log: schema.ai_suggestion_usage_log,
        bible_texts: schema.bible_texts,
        books: schema.books,
        chapter_assignments: schema.chapter_assignments,
        pericope_verses: schema.pericope_verses,
        pericope_sets: schema.pericope_sets,
        project_unit_bible_books: schema.project_unit_bible_books,
        project_units: schema.project_units,
        projects: schema.projects,
        translated_verses: schema.translated_verses,
        users: schema.users,
        organizations: schema.organizations,
        languages: schema.languages,
        bibles: schema.bibles,
        authUser: schema.authUser,
        authSession: schema.authSession,
        bibleProviderEnum: schema.bibleProviderEnum,
        milestoneTypeEnum: schema.milestoneTypeEnum,
        projectStatusEnum: schema.projectStatusEnum,
        projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
        scriptDirectionEnum: schema.scriptDirectionEnum,
        userStatusEnum: schema.userStatusEnum,
      })
    );
    await client.exec(statements.join('\n'));
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
  }, 30_000);
  afterAll(async () => {
    await client.close();
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

  it('identifies the true title anchor across chapters, sections, and missing source verses', async () => {
    await db
      .insert(schema.chapter_assignments)
      .values({ projectUnitId, bibleId, bookId, chapterNumber: 3, isAiEnabled: true });
    await db.insert(schema.bible_texts).values(
      [1, 2, 3].map((verseNumber) => ({
        bibleId,
        bookId,
        chapterNumber: 3,
        verseNumber,
        text: 'Continuation',
      }))
    );
    await db.insert(schema.pericope_verses).values([
      {
        pericopeSetId,
        bookId,
        chapterNumber: 2,
        verseNumber: 20,
        pericopeNumber: '12',
        pericopeTitle: 'Deliverance',
      },
      {
        pericopeSetId,
        bookId,
        chapterNumber: 3,
        verseNumber: 1,
        pericopeNumber: '12',
        pericopeTitle: 'Deliverance',
      },
      {
        pericopeSetId,
        bookId,
        chapterNumber: 3,
        verseNumber: 2,
        section: 1,
        pericopeNumber: '12',
        pericopeTitle: 'Another section',
      },
      {
        pericopeSetId,
        bookId,
        chapterNumber: 3,
        verseNumber: 3,
        section: 2,
        pericopeNumber: '12',
        pericopeTitle: 'Next section',
      },
    ]);
    const continuation = await resolvePericopes({
      ...query(),
      chapterNumber: 3,
      pericopeNumbers: ['12', '1_12'],
    });
    expect(
      continuation.ok && continuation.data.groups.map((group) => group.startsPericope)
    ).toEqual([false, true]);
    const otherSection = await resolvePericopes({
      ...query(),
      chapterNumber: 3,
      pericopeNumbers: ['2_12'],
    });
    expect(otherSection.ok && otherSection.data.groups[0].startsPericope).toBe(true);
    // The genuine first set verse still counts even when its source text has not arrived.
    await db.insert(schema.pericope_verses).values({
      pericopeSetId,
      bookId,
      chapterNumber: 2,
      verseNumber: 21,
      section: 2,
      pericopeNumber: '12',
      pericopeTitle: 'Next section',
    });
    const missingFirst = await resolvePericopes({
      ...query(),
      chapterNumber: 3,
      pericopeNumbers: ['2_12'],
    });
    expect(missingFirst.ok && missingFirst.data.groups[0].startsPericope).toBe(false);
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

  it('waits for the genuine first verse before caching a title and then keeps one cache entry', async () => {
    await db
      .insert(schema.chapter_assignments)
      .values({ projectUnitId, bibleId, bookId, chapterNumber: 2, isAiEnabled: true });
    await db.insert(schema.pericope_verses).values(
      [1, 2].map((verseNumber) => ({
        pericopeSetId,
        bookId,
        chapterNumber: 2,
        verseNumber,
        section: null,
        pericopeNumber: '9a',
        pericopeTitle: 'A stable title',
      }))
    );
    const [secondVerse] = await db
      .insert(schema.bible_texts)
      .values({ bibleId, bookId, chapterNumber: 2, verseNumber: 2, text: 'Second verse' })
      .returning();
    const result = {
      projectUnitId,
      bibleTextId: secondVerse.id,
      pericopeSetId,
      pericopeNumber: '9a',
      suggestedText: 'The cached title',
      modelInfo: 'test-model',
    };
    expect((await savePericopeSuggestion(result)).ok).toBe(true);
    expect(
      await db
        .select()
        .from(schema.ai_pericope_suggestions)
        .where(
          and(
            eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId),
            eq(schema.ai_pericope_suggestions.chapterNumber, 2)
          )
        )
    ).toHaveLength(0);

    const [firstVerse] = await db
      .insert(schema.bible_texts)
      .values({ bibleId, bookId, chapterNumber: 2, verseNumber: 1, text: 'First verse' })
      .returning();
    const afterBackfill = await resolvePericopes({
      projectUnitId,
      bibleId,
      bookCode: 'GEN',
      chapterNumber: 2,
      pericopeNumbers: ['9a'],
    });
    expect(afterBackfill.ok && afterBackfill.data.groups[0].verses[0].bibleTextId).toBe(
      firstVerse.id
    );
    expect(afterBackfill.ok && afterBackfill.data.groups[0].suggestion).toBeNull();
    expect(
      (
        await savePericopeSuggestion({
          ...result,
          bibleTextId: firstVerse.id,
          suggestedText: 'The cached title',
        })
      ).ok
    ).toBe(true);
    expect(
      await db
        .select()
        .from(schema.ai_pericope_suggestions)
        .where(
          and(
            eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId),
            eq(schema.ai_pericope_suggestions.chapterNumber, 2)
          )
        )
    ).toHaveLength(1);
    expect(
      (
        await logPericopeUsage(userId, {
          projectUnitId,
          bibleTextId: firstVerse.id,
          pericopeNumber: '9a',
          wasUsed: false,
        })
      ).ok
    ).toBe(true);
  });

  it('ignores title-less groups and authored headings, rejects another group, and stores old-set results', async () => {
    expect((await savePericopeSuggestion({ ...heading(), bibleTextId: bibleTextIds[3] })).ok).toBe(
      false
    );
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
    await db
      .delete(schema.ai_pericope_suggestions)
      .where(eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId));
    await db
      .update(schema.projects)
      .set({ pericopeSetId: otherSetId })
      .where(eq(schema.projects.id, projectId));
    expect((await savePericopeSuggestion(heading())).ok).toBe(true);
    const storedOldSet = await db
      .select()
      .from(schema.ai_pericope_suggestions)
      .where(eq(schema.ai_pericope_suggestions.projectUnitId, projectUnitId));
    expect(storedOldSet).toHaveLength(1);
    expect(storedOldSet[0].pericopeSetId).toBe(pericopeSetId);
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
    // The editor still shows the old-set title, so accepting it has to follow that set.
    expect(
      (
        await logPericopeUsage(userId, {
          projectUnitId,
          bibleTextId: bibleTextIds[0],
          pericopeNumber: '4a',
          wasUsed: true,
        })
      ).ok
    ).toBe(true);
    expect(
      await db
        .select()
        .from(schema.ai_pericope_suggestion_usage)
        .where(eq(schema.ai_pericope_suggestion_usage.suggestionId, storedOldSet[0].id))
    ).toMatchObject([{ userId, wasUsed: true }]);
  });

  it('still lets a verse usage correction overwrite an earlier acceptance', async () => {
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
    expect(records[0].wasUsed).toBe(false);
  });
});
