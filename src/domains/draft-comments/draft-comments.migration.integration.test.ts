import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as draftSchema from '@/db/draft-comments.schema';
import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

async function seedMinimalGraph() {
  await database.insert(schema.authUser).values({
    id: 'auth-1',
    name: 'A',
    email: 'a@example.com',
    emailVerified: true,
  });
  await database.insert(schema.users).values({
    id: 1,
    authUserId: 'auth-1',
    username: 'author',
    email: 'a@example.com',
  });
  await database.insert(schema.organizations).values({ id: 1, name: 'Org' });
  await database.insert(schema.languages).values({ id: 1, langName: 'English' });
  await database.insert(schema.books).values({ id: 40, code: 'MAT', eng_display_name: 'Matthew' });
  await database.insert(schema.pericope_sets).values([
    { id: 1, name: 'FIA' },
    { id: 2, name: 'Other' },
  ]);
  await database.insert(schema.bibles).values({
    id: 1,
    languageId: 1,
    name: 'Test',
    abbreviation: 'TST',
    provider: 'dbl',
  });
  await database.insert(schema.projects).values({
    id: 1,
    name: 'P',
    sourceLanguage: 1,
    targetLanguage: 1,
    organization: 1,
    pericopeSetId: 1,
  });
  await database.insert(schema.project_units).values({ id: 1, projectId: 1, name: 'Unit' });
  await database.insert(schema.chapter_assignments).values({
    id: 1,
    projectUnitId: 1,
    bibleId: 1,
    bookId: 40,
    chapterNumber: 1,
  });
  await database.insert(schema.bible_texts).values({
    id: 10,
    bibleId: 1,
    bookId: 40,
    chapterNumber: 1,
    verseNumber: 1,
    text: 'v1',
  });
  await database.insert(schema.pericope_verses).values({
    pericopeSetId: 1,
    bookId: 40,
    chapterNumber: 1,
    verseNumber: 1,
    pericopeNumber: '1',
    pericopeTitle: 'Start',
  });
}

describe('draft-comments migration 0039 (PGlite, disposable)', () => {
  beforeAll(async () => {
    await createTestSchema(client, {
      userStatusEnum: schema.userStatusEnum,
      scriptDirectionEnum: schema.scriptDirectionEnum,
      bibleProviderEnum: schema.bibleProviderEnum,
      resourceProviderEnum: schema.resourceProviderEnum,
      ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
      projectStatusEnum: schema.projectStatusEnum,
      milestoneTypeEnum: schema.milestoneTypeEnum,
      authUser: schema.authUser,
      authSession: schema.authSession,
      users: schema.users,
      organizations: schema.organizations,
      languages: schema.languages,
      books: schema.books,
      pericope_sets: schema.pericope_sets,
      pericope_verses: schema.pericope_verses,
      bible_provider_resources: schema.bible_provider_resources,
      bibles: schema.bibles,
      projects: schema.projects,
      project_units: schema.project_units,
      chapter_assignments: schema.chapter_assignments,
      bible_texts: schema.bible_texts,
    });

    const migrationSql = readFileSync(
      join(migrationDir, '0039_add_draft_chapter_comments.sql'),
      'utf8'
    ).replaceAll('--> statement-breakpoint', '');
    await client.exec(migrationSql);
  }, 60_000);

  beforeEach(async () => {
    await database.delete(draftSchema.chapter_comment_reactions);
    await database.delete(draftSchema.chapter_comments);
    await database.delete(schema.pericope_verses);
    await database.delete(schema.bible_texts);
    await database.delete(schema.chapter_assignments);
    await database.delete(schema.project_units);
    await database.delete(schema.projects);
    await database.delete(schema.bibles);
    await database.delete(schema.pericope_sets);
    await database.delete(schema.books);
    await database.delete(schema.languages);
    await database.delete(schema.organizations);
    await database.delete(schema.users);
    await database.delete(schema.authUser);
    await seedMinimalGraph();
  });

  afterAll(async () => {
    await client.close();
  });

  it('retains original bibleTextId after source DELETE; sticky after recreation', async () => {
    const [created] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'verse',
        anchorKind: 'verse',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorBibleTextId: 10,
        anchorVerseNumber: 1,
        connectionState: 'connected',
      })
      .returning();

    await database.delete(schema.bible_texts).where(eq(schema.bible_texts.id, 10));
    const [afterDelete] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, created!.id));
    expect(afterDelete).toMatchObject({
      connectionState: 'unconnected',
      anchorBibleTextId: 10,
      anchorVerseNumber: 1,
      anchorBibleId: 1,
      anchorBookId: 40,
      anchorChapterNumber: 1,
    });

    await database.insert(schema.bible_texts).values({
      id: 10,
      bibleId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 1,
      text: 'v1-again',
    });
    const [afterRecreate] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, created!.id));
    expect(afterRecreate?.connectionState).toBe('unconnected');
    expect(afterRecreate?.anchorBibleTextId).toBe(10);
  });

  it('retains original pericopeSetId after set DELETE; sticky after recreation', async () => {
    await database.delete(schema.pericope_verses);
    await database
      .update(schema.projects)
      .set({ pericopeSetId: null })
      .where(eq(schema.projects.id, 1));

    const [created] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'pericope',
        anchorKind: 'pericope',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorPericopeSetId: 1,
        anchorPericopeNumber: '1',
        anchorPericopeTitle: 'Start',
        connectionState: 'connected',
      })
      .returning();

    await database.delete(schema.pericope_sets).where(eq(schema.pericope_sets.id, 1));
    const [afterDelete] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, created!.id));
    expect(afterDelete).toMatchObject({
      connectionState: 'unconnected',
      anchorPericopeSetId: 1,
      anchorPericopeNumber: '1',
      anchorPericopeTitle: 'Start',
    });

    await database.insert(schema.pericope_sets).values({ id: 1, name: 'FIA' });
    await database.insert(schema.pericope_verses).values({
      pericopeSetId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 1,
      pericopeNumber: '1',
      pericopeTitle: 'Start',
    });
    const [afterRecreate] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, created!.id));
    expect(afterRecreate?.connectionState).toBe('unconnected');
    expect(afterRecreate?.anchorPericopeSetId).toBe(1);
  });

  it('unconnects on membership INSERT addition without reattach', async () => {
    await database.insert(draftSchema.chapter_comments).values({
      projectId: 1,
      chapterAssignmentId: 1,
      authorUserId: 1,
      bodyKind: 'emoji',
      emoji: '👍',
      anchorKind: 'pericope',
      anchorBibleId: 1,
      anchorBookId: 40,
      anchorChapterNumber: 1,
      anchorPericopeSetId: 1,
      anchorPericopeNumber: '1',
      connectionState: 'connected',
    });

    await database.insert(schema.pericope_verses).values({
      pericopeSetId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 2,
      pericopeNumber: '1',
      pericopeTitle: 'Start',
    });

    const [row] = await database.select().from(draftSchema.chapter_comments);
    expect(row?.connectionState).toBe('unconnected');
    expect(row?.anchorPericopeSetId).toBe(1);
    expect(row?.anchorPericopeNumber).toBe('1');
  });

  it('unconnects on project.pericope_set_id change and stays sticky when restored', async () => {
    await database.insert(draftSchema.chapter_comments).values({
      projectId: 1,
      chapterAssignmentId: 1,
      authorUserId: 1,
      bodyKind: 'text',
      bodyText: 'p',
      anchorKind: 'pericope',
      anchorBibleId: 1,
      anchorBookId: 40,
      anchorChapterNumber: 1,
      anchorPericopeSetId: 1,
      anchorPericopeNumber: '1',
      connectionState: 'connected',
    });

    await database
      .update(schema.projects)
      .set({ pericopeSetId: 2 })
      .where(eq(schema.projects.id, 1));
    await database
      .update(schema.projects)
      .set({ pericopeSetId: 1 })
      .where(eq(schema.projects.id, 1));

    const [row] = await database.select().from(draftSchema.chapter_comments);
    expect(row?.connectionState).toBe('unconnected');
    expect(row?.anchorPericopeSetId).toBe(1);
  });

  it('atomic set_chapter_comment_reaction toggles same emoji and replaces', async () => {
    const [comment] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'r',
        anchorKind: 'verse',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorBibleTextId: 10,
        anchorVerseNumber: 1,
      })
      .returning();

    const setA = await client.query<{ emoji: string | null }>(
      `SELECT set_chapter_comment_reaction($1, $2, $3) AS emoji`,
      [comment!.id, 1, '😀']
    );
    expect(setA.rows[0]?.emoji).toBe('😀');

    const setB = await client.query<{ emoji: string | null }>(
      `SELECT set_chapter_comment_reaction($1, $2, $3) AS emoji`,
      [comment!.id, 1, '🎉']
    );
    expect(setB.rows[0]?.emoji).toBe('🎉');

    const toggle = await client.query<{ emoji: string | null }>(
      `SELECT set_chapter_comment_reaction($1, $2, $3) AS emoji`,
      [comment!.id, 1, '🎉']
    );
    expect(toggle.rows[0]?.emoji).toBeNull();

    const remaining = await database.select().from(draftSchema.chapter_comment_reactions);
    expect(remaining).toHaveLength(0);
  });
});
