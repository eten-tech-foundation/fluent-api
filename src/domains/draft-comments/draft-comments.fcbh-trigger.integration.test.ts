import { and, eq } from 'drizzle-orm';
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
  await database.insert(schema.pericope_sets).values({ id: 1, name: 'FCBH' });
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
}

describe('draft-comments FCBH public-id invalidation (PGlite)', () => {
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
    await database.delete(draftSchema.chapter_comments);
    await database.delete(schema.pericope_verses);
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

  it('unconnects FCBH public 6_1 without touching sibling 7_1 (both raw 1)', async () => {
    await database.insert(schema.pericope_verses).values([
      {
        pericopeSetId: 1,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 10,
        section: 6,
        pericopeNumber: '1',
        pericopeTitle: null,
      },
      {
        pericopeSetId: 1,
        bookId: 40,
        chapterNumber: 1,
        verseNumber: 20,
        section: 7,
        pericopeNumber: '1',
        pericopeTitle: null,
      },
    ]);
    const [c6] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'on 6_1',
        anchorKind: 'pericope',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorPericopeSetId: 1,
        anchorPericopeNumber: '6_1',
        connectionState: 'connected',
      })
      .returning();
    const [c7] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'on 7_1',
        anchorKind: 'pericope',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorPericopeSetId: 1,
        anchorPericopeNumber: '7_1',
        connectionState: 'connected',
      })
      .returning();

    await database
      .delete(schema.pericope_verses)
      .where(
        and(
          eq(schema.pericope_verses.pericopeSetId, 1),
          eq(schema.pericope_verses.section, 6),
          eq(schema.pericope_verses.pericopeNumber, '1')
        )
      );

    const [after6] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, c6!.id));
    const [after7] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, c7!.id));
    expect(after6).toMatchObject({ connectionState: 'unconnected', anchorPericopeNumber: '6_1' });
    expect(after7).toMatchObject({ connectionState: 'connected', anchorPericopeNumber: '7_1' });
  });

  it('section change unconnects old and new public identities; never reattaches', async () => {
    await database.insert(schema.pericope_verses).values({
      pericopeSetId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 11,
      section: 6,
      pericopeNumber: '1',
      pericopeTitle: null,
    });
    const [cOld] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'old',
        anchorKind: 'pericope',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorPericopeSetId: 1,
        anchorPericopeNumber: '6_1',
        connectionState: 'connected',
      })
      .returning();
    const [cNew] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'new',
        anchorKind: 'pericope',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorPericopeSetId: 1,
        anchorPericopeNumber: '8_1',
        connectionState: 'connected',
      })
      .returning();

    await database
      .update(schema.pericope_verses)
      .set({ section: 8 })
      .where(
        and(eq(schema.pericope_verses.pericopeSetId, 1), eq(schema.pericope_verses.verseNumber, 11))
      );

    const [afterOld] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, cOld!.id));
    const [afterNew] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, cNew!.id));
    expect(afterOld?.connectionState).toBe('unconnected');
    expect(afterOld?.anchorPericopeNumber).toBe('6_1');
    expect(afterNew?.connectionState).toBe('unconnected');
    expect(afterNew?.anchorPericopeNumber).toBe('8_1');

    await database.insert(schema.pericope_verses).values({
      pericopeSetId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 12,
      section: 6,
      pericopeNumber: '1',
      pericopeTitle: null,
    });
    const [still] = await database
      .select()
      .from(draftSchema.chapter_comments)
      .where(eq(draftSchema.chapter_comments.id, cOld!.id));
    expect(still?.connectionState).toBe('unconnected');
  });
});
