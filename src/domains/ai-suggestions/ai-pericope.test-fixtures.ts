import type { PGlite } from '@electric-sql/pglite';

import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

import type { db } from '@/db';

import * as schema from '@/db/schema';

interface PericopeIntegrationFixture {
  bibleId: number;
  bibleTextIds: number[];
  bookId: number;
  otherSetId: number;
  pericopeSetId: number;
  projectId: number;
  projectUnitId: number;
  userId: number;
}

export async function setupPericopeIntegrationTest(
  client: PGlite,
  database: typeof db
): Promise<PericopeIntegrationFixture> {
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
      bible_provider_resources: schema.bible_provider_resources,
      authUser: schema.authUser,
      authSession: schema.authSession,
      bibleProviderEnum: schema.bibleProviderEnum,
      resourceProviderEnum: schema.resourceProviderEnum,
      ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      milestoneTypeEnum: schema.milestoneTypeEnum,
      projectStatusEnum: schema.projectStatusEnum,
      projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
      scriptDirectionEnum: schema.scriptDirectionEnum,
      userStatusEnum: schema.userStatusEnum,
    })
  );
  await client.exec(statements.join('\n'));

  const suffix = Date.now().toString();
  const [org] = await database
    .insert(schema.organizations)
    .values({ name: `Pericope test ${suffix}` })
    .returning();
  const [language] = await database
    .insert(schema.languages)
    .values({ langName: `Test ${suffix}` })
    .returning();
  const [user] = await database
    .insert(schema.users)
    .values({ username: `pericope-${suffix}`, email: `${suffix}@example.test` })
    .returning();
  const userId = user.id;

  const sets = await database
    .insert(schema.pericope_sets)
    .values([{ name: `FIA-${suffix}` }, { name: `FCBH-${suffix}` }])
    .returning();
  const pericopeSetId = sets[0].id;
  const otherSetId = sets[1].id;

  const [project] = await database
    .insert(schema.projects)
    .values({
      name: 'Pericope test',
      sourceLanguage: language.id,
      targetLanguage: language.id,
      organization: org.id,
      pericopeSetId,
    })
    .returning();
  const projectId = project.id;

  const [unit] = await database.insert(schema.project_units).values({ projectId }).returning();
  const projectUnitId = unit.id;

  const [bible] = await database
    .insert(schema.bibles)
    .values({ languageId: language.id, name: `Source ${suffix}`, abbreviation: `s-${suffix}` })
    .returning();
  const bibleId = bible.id;

  await database
    .insert(schema.books)
    .values({ code: 'GEN', eng_display_name: 'Genesis' })
    .onConflictDoNothing();
  const [book] = await database.select().from(schema.books).where(eq(schema.books.code, 'GEN'));
  const bookId = book.id;

  await database.insert(schema.project_unit_bible_books).values({ projectUnitId, bibleId, bookId });
  await database
    .insert(schema.chapter_assignments)
    .values({ projectUnitId, bibleId, bookId, chapterNumber: 1, isAiEnabled: true });

  const texts = await database
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
  const bibleTextIds = texts.map((text: { id: number }) => text.id);

  await database.insert(schema.pericope_verses).values(
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

  await database.insert(schema.translated_verses).values([
    { projectUnitId, bibleTextId: bibleTextIds[1], content: '' },
    {
      projectUnitId,
      bibleTextId: bibleTextIds[2],
      content: 'Already translated',
      markers: { headings: [{ marker: 's', text: 'An authored heading' }] },
    },
  ]);

  await database
    .insert(schema.ai_suggestions)
    .values({ projectUnitId, bibleTextId: bibleTextIds[3], suggestedText: 'Cached scripture' });

  return {
    bibleId,
    bibleTextIds,
    bookId,
    otherSetId,
    pericopeSetId,
    projectId,
    projectUnitId,
    userId,
  };
}
