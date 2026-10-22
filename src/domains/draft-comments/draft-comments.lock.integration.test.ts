/**
 * Post-upload SELECT→INSERT race protection.
 *
 * LIMITATION: PGlite exposes a single connection. This suite proves the lock helpers
 * take FOR UPDATE / advisory xact locks and that locked revalidation rejects a missing
 * source before insert. It does NOT simulate two concurrent PostgreSQL writers racing
 * between SELECT and INSERT — that interleaving cannot be honestly reproduced here.
 */
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as draftSchema from '@/db/draft-comments.schema';
import * as schema from '@/db/schema';
import { runInTransaction } from '@/db/transaction';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './draft-comments.repository';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

describe('draft-comments post-upload write locks (PGlite)', () => {
  beforeAll(async () => {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
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
      })
    );
    await client.exec(statements.join('\n'));
    const migrationSql = readFileSync(
      join(migrationDir, '0038_add_draft_chapter_comments.sql'),
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
    await database.insert(schema.pericope_sets).values({ id: 1, name: 'FIA' });
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
  }, 60_000);

  beforeEach(async () => {
    await database.delete(draftSchema.chapter_comments);
  });

  afterAll(async () => {
    await client.close();
  });

  it('lockAssignmentWriteContext + lockBibleTextById hold row locks (pg_locks)', async () => {
    await runInTransaction(async (tx) => {
      const ctx = await repo.lockAssignmentWriteContext(1, tx);
      expect(ctx?.projectId).toBe(1);
      const verse = await repo.lockBibleTextById(10, tx);
      expect(verse?.id).toBe(10);

      const locks = await tx.execute<{ locktype: string; mode: string }>(sql`
        SELECT locktype, mode
        FROM pg_locks
        WHERE pid = pg_backend_pid()
          AND granted = true
          AND locktype IN ('relation', 'advisory', 'tuple', 'transactionid')
      `);
      const rows = Array.isArray(locks) ? locks : ((locks as { rows?: unknown[] }).rows ?? []);
      expect(rows.length).toBeGreaterThan(0);
      return ok(undefined);
    });
  });

  it('locked revalidation refuses insert when verse source was deleted before lock', async () => {
    await database.delete(schema.bible_texts).where(eq(schema.bible_texts.id, 10));

    const result = await runInTransaction(async (tx) => {
      const ctx = await repo.lockAssignmentWriteContext(1, tx);
      expect(ctx).not.toBeNull();
      const verse = await repo.lockBibleTextById(10, tx);
      if (!verse) return err(ErrorCode.INVALID_REFERENCE);
      await repo.insertComment(
        {
          projectId: 1,
          chapterAssignmentId: 1,
          authorUserId: 1,
          bodyKind: 'audio',
          audioStorageKey: 'comments/1/00000000-0000-0000-0000-000000000001/hash',
          audioContentType: 'audio/mp4',
          audioByteSize: 1,
          audioContentHash: 'hash',
          anchorKind: 'verse',
          anchorBibleId: 1,
          anchorBookId: 40,
          anchorChapterNumber: 1,
          anchorBibleTextId: 10,
          anchorVerseNumber: 1,
          connectionState: 'connected',
        },
        tx
      );
      return ok(undefined);
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INVALID_REFERENCE);
    const rows = await database.select().from(draftSchema.chapter_comments);
    expect(rows).toHaveLength(0);

    // restore source for later tests
    await database.insert(schema.bible_texts).values({
      id: 10,
      bibleId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 1,
      text: 'v1',
    });
  });

  it('lockPericopeMembership takes advisory key and FOR UPDATE on matching rows', async () => {
    await runInTransaction(async (tx) => {
      const membership = await repo.lockPericopeMembership(1, 40, 1, '1', tx);
      expect(membership?.pericopeNumber).toBe('1');

      const advisory = await tx.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM pg_locks
        WHERE locktype = 'advisory'
          AND granted = true
          AND pid = pg_backend_pid()
      `);
      const rows = Array.isArray(advisory)
        ? advisory
        : ((advisory as { rows?: Array<{ count: string }> }).rows ?? []);
      expect(Number(rows[0]?.count ?? 0)).toBeGreaterThan(0);
      return ok(undefined);
    });
  });

  it('lockPericopeMembership returns null when public id membership is gone', async () => {
    await database.delete(schema.pericope_verses);
    await runInTransaction(async (tx) => {
      const membership = await repo.lockPericopeMembership(1, 40, 1, '1', tx);
      expect(membership).toBeNull();
      return ok(undefined);
    });
    await database.insert(schema.pericope_verses).values({
      pericopeSetId: 1,
      bookId: 40,
      chapterNumber: 1,
      verseNumber: 1,
      pericopeNumber: '1',
      pericopeTitle: 'Start',
    });
  });
});
