import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as draftSchema from '@/db/draft-comments.schema';
import * as schema from '@/db/schema';
import { deleteVerseAudio, isAudioStorageAvailable, uploadVerseAudio } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode } from '@/lib/types';

import { createAudioComment } from './draft-comments.audio.service';
import * as repo from './draft-comments.repository';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/lib/audio-storage', () => ({
  isAudioStorageAvailable: vi.fn(() => true),
  uploadVerseAudio: vi.fn(async () => {}),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}`),
}));

const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
const audioBytes = Buffer.from('pglite-audio');

describe('createAudioComment (PGlite + mocked storage)', () => {
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
      join(migrationDir, '0039_add_draft_chapter_comments.sql'),
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
    await database.insert(schema.chapter_assignments).values({
      id: 1,
      projectUnitId: 1,
      bibleId: 1,
      bookId: 40,
      chapterNumber: 1,
    });
    await database.insert(schema.chapter_assignments).values({
      id: 2,
      projectUnitId: 1,
      bibleId: 1,
      bookId: 40,
      chapterNumber: 2,
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

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(isAudioStorageAvailable).mockReturnValue(true);
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
    await database.delete(draftSchema.chapter_comment_reactions);
    await database.delete(draftSchema.chapter_comments);
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

  it('persists root audio, reply-to-root, and flattened reply-to-reply', async () => {
    const root = await createAudioComment(
      writer,
      1,
      { kind: 'verse', bibleTextId: 10 },
      { data: audioBytes, contentType: 'audio/mp4', durationSeconds: 2 }
    );
    expect(root.ok).toBe(true);
    if (!root.ok) return;
    expect(root.data.parentCommentId).toBeNull();
    expect(root.data.author.userId).toBe(1);
    expect(uploadVerseAudio).toHaveBeenCalledTimes(1);
    const uploadedKey = vi.mocked(uploadVerseAudio).mock.calls[0]?.[0];
    expect(uploadedKey).toMatch(/^comments\/1\/[0-9a-f-]{36}\//);
    expect(uploadedKey?.startsWith('comments/pending/')).toBe(false);
    expect(root.data.audio?.contentHash).toBeTruthy();

    // Force Unconnected on root — replies must retain it even if source is gone.
    await database
      .update(draftSchema.chapter_comments)
      .set({ connectionState: 'unconnected' })
      .where(eq(draftSchema.chapter_comments.id, root.data.id));

    const reply = await createAudioComment(
      writer,
      1,
      { kind: 'verse', bibleTextId: 10 },
      { data: Buffer.from('reply-a'), contentType: 'audio/mpeg', durationSeconds: 1 },
      null,
      root.data.id
    );
    expect(reply.ok).toBe(true);
    if (!reply.ok) return;
    expect(reply.data.parentCommentId).toBe(root.data.id);
    expect(reply.data.connectionState).toBe('unconnected');
    expect(reply.data.anchor.bibleTextId).toBe(10);

    const nested = await createAudioComment(
      writer,
      1,
      null,
      { data: Buffer.from('reply-b'), contentType: 'audio/ogg', durationSeconds: 1 },
      null,
      reply.data.id
    );
    expect(nested.ok).toBe(true);
    if (!nested.ok) return;
    expect(nested.data.parentCommentId).toBe(root.data.id);

    const rows = await database.select().from(draftSchema.chapter_comments);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.parentCommentId === root.data.id)).toHaveLength(2);
    expect(rows.every((r) => !r.audioStorageKey?.startsWith('comments/pending/'))).toBe(true);
  });

  it('rejects cross-chapter target before upload and leaves no row', async () => {
    const [other] = await database
      .insert(draftSchema.chapter_comments)
      .values({
        projectId: 1,
        chapterAssignmentId: 2,
        authorUserId: 1,
        bodyKind: 'text',
        bodyText: 'other chapter',
        anchorKind: 'verse',
        anchorBibleId: 1,
        anchorBookId: 40,
        anchorChapterNumber: 2,
        anchorBibleTextId: 10,
        anchorVerseNumber: 1,
      })
      .returning();

    const result = await createAudioComment(
      writer,
      1,
      null,
      { data: audioBytes, contentType: 'audio/mp4', durationSeconds: 1 },
      null,
      other!.id
    );
    expect(result.ok).toBe(false);
    expect(uploadVerseAudio).not.toHaveBeenCalled();
    const rows = await database.select().from(draftSchema.chapter_comments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(other!.id);
  });

  it('leaves no row when storage upload fails', async () => {
    vi.mocked(uploadVerseAudio).mockRejectedValue(new Error('r2 down'));
    const result = await createAudioComment(
      writer,
      1,
      { kind: 'verse', bibleTextId: 10 },
      { data: audioBytes, contentType: 'audio/mp4', durationSeconds: 1 }
    );
    expect(result.ok).toBe(false);
    const rows = await database.select().from(draftSchema.chapter_comments);
    expect(rows).toHaveLength(0);
    expect(deleteVerseAudio).not.toHaveBeenCalled();
  });

  it('cleans only the attempt key when short write fails after upload', async () => {
    const priorKey = 'comments/1/00000000-0000-0000-0000-000000000099/prior';
    await database.insert(draftSchema.chapter_comments).values({
      projectId: 1,
      chapterAssignmentId: 1,
      authorUserId: 1,
      bodyKind: 'audio',
      audioStorageKey: priorKey,
      audioContentType: 'audio/mp4',
      audioByteSize: 4,
      audioContentHash: 'priorhash',
      anchorKind: 'verse',
      anchorBibleId: 1,
      anchorBookId: 40,
      anchorChapterNumber: 1,
      anchorBibleTextId: 10,
      anchorVerseNumber: 1,
    });

    const insertSpy = vi
      .spyOn(repo, 'insertComment')
      .mockRejectedValueOnce(new Error('insert failed'));

    const result = await createAudioComment(
      writer,
      1,
      { kind: 'verse', bibleTextId: 10 },
      { data: audioBytes, contentType: 'audio/mp4', durationSeconds: 1 }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(ErrorCode.INTERNAL_ERROR);

    const attemptKey = vi.mocked(uploadVerseAudio).mock.calls[0]?.[0];
    expect(attemptKey).toMatch(/^comments\/1\/[0-9a-f-]{36}\//);
    expect(attemptKey).not.toBe(priorKey);

    const rows = await database.select().from(draftSchema.chapter_comments);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.audioStorageKey).toBe(priorKey);

    expect(deleteVerseAudio).toHaveBeenCalledTimes(1);
    expect(deleteVerseAudio).toHaveBeenCalledWith(attemptKey);
    expect(deleteVerseAudio).not.toHaveBeenCalledWith(priorKey);

    insertSpy.mockRestore();
  });
});
