import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as draftSchema from '@/db/draft-comments.schema';
import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { PERMISSIONS } from '@/lib/permissions';

import * as draftCommentsService from './draft-comments.service';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

describe('draft-comments reaction serialization (PGlite)', () => {
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
      project_unit_bible_books: schema.project_unit_bible_books,
      chapter_assignments: schema.chapter_assignments,
      bible_texts: schema.bible_texts,
    });
    const migrationSql = readFileSync(
      join(migrationDir, '0041_add_draft_chapter_comments.sql'),
      'utf8'
    ).replaceAll('--> statement-breakpoint', '');
    await client.exec(migrationSql);

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
    await database
      .insert(schema.books)
      .values({ id: 40, code: 'MAT', eng_display_name: 'Matthew' });
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
    });
    await database.insert(schema.project_units).values({ id: 1, projectId: 1, name: 'Unit' });
    await database.insert(schema.project_unit_bible_books).values({
      projectUnitId: 1,
      bibleId: 1,
      bookId: 40,
    });
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
  }, 60_000);

  let commentId = 0;

  beforeEach(async () => {
    await database.delete(draftSchema.chapter_comment_reactions);
    await database.delete(draftSchema.chapter_comments);
    const [row] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 1,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'hi',
        anchorKind: 'verse',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 1,
        anchorBibleTextId: 10,
        anchorVerseNumber: 1,
      })
      .returning();
    commentId = row!.id;
  });

  afterAll(async () => {
    await client.close();
  });

  const writer = {
    id: 1,
    grants: [
      {
        orgId: 1,
        projectId: 1,
        permissions: new Set([PERMISSIONS.CONTENT_VIEW, PERMISSIONS.COMMENT_WRITE]),
      },
    ],
  };

  it('parallel same-emoji toggles leave at most one row and a consistent final state', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => draftCommentsService.setReaction(writer, 1, commentId, '😀'))
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await database.select().from(draftSchema.chapter_comment_reactions);
    expect(rows.length).toBeLessThanOrEqual(1);
    if (rows.length === 1) {
      expect(rows[0]?.emoji).toBe('😀');
      expect(rows[0]?.userId).toBe(1);
      expect(rows[0]?.commentId).toBe(commentId);
    }
  });

  it('replace then clear leaves zero reactions for the user/comment', async () => {
    await draftCommentsService.setReaction(writer, 1, commentId, '😀');
    await draftCommentsService.setReaction(writer, 1, commentId, '🎉');
    const mid = await database.select().from(draftSchema.chapter_comment_reactions);
    expect(mid).toHaveLength(1);
    expect(mid[0]?.emoji).toBe('🎉');

    await draftCommentsService.setReaction(writer, 1, commentId, '🎉');
    const end = await database.select().from(draftSchema.chapter_comment_reactions);
    expect(end).toHaveLength(0);
  });
});
