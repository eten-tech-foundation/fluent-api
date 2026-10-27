import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppPolicyUser } from '@/lib/types';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import env from '@/env';
import { deleteVerseAudio } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';
import { deleteTake } from './verse-audio.service';

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
vi.mock('@/lib/audio-storage', () => ({
  audioBlobName: vi.fn(
    (unitId: number, textId: number, hash: string) => `unit-${unitId}/text-${textId}/${hash}`
  ),
  audioBucket: vi.fn(() => 'verse-audio'),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(async (key: string) => `https://r2.example/${key}?sig=x`),
}));

describe('deleteTake (production service on PGlite)', () => {
  let projectUnitId: number;
  let bibleTextId: number;
  let userId: number;
  let orgId: number;
  let projectId: number;
  let storageObjectId: number;
  let recordingId: number;
  let takeId: number;

  const actor = (): AppPolicyUser => ({
    id: userId,
    grants: [
      {
        orgId,
        projectId,
        permissions: new Set([PERMISSIONS.CONTENT_UPDATE, PERMISSIONS.PROJECT_VIEW]),
      },
    ],
  });

  const scope = () => ({ orgId, projectId });

  beforeAll(async () => {
    await createTestSchema(client, {
      organizations: schema.organizations,
      languages: schema.languages,
      authUser: schema.authUser,
      authSession: schema.authSession,
      users: schema.users,
      pericope_sets: schema.pericope_sets,
      projects: schema.projects,
      project_units: schema.project_units,
      books: schema.books,
      bibles: schema.bibles,
      bible_texts: schema.bible_texts,
      bible_provider_resources: schema.bible_provider_resources,
      storage_objects: schema.storage_objects,
      verse_audio_recordings: schema.verse_audio_recordings,
      verse_audio_takes: schema.verse_audio_takes,
      bibleProviderEnum: schema.bibleProviderEnum,
      resourceProviderEnum: schema.resourceProviderEnum,
      ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      projectStatusEnum: schema.projectStatusEnum,
      projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
      milestoneTypeEnum: schema.milestoneTypeEnum,
      scriptDirectionEnum: schema.scriptDirectionEnum,
      userStatusEnum: schema.userStatusEnum,
      verseAudioConflictStatusEnum: schema.verseAudioConflictStatusEnum,
      verseAudioGranularityEnum: schema.verseAudioGranularityEnum,
    });
  }, 60_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);

    await database.delete(schema.verse_audio_takes);
    await database.delete(schema.verse_audio_recordings);
    await database.delete(schema.storage_objects);
    await database.delete(schema.bible_texts);
    await database.delete(schema.bibles);
    await database.delete(schema.books);
    await database.delete(schema.project_units);
    await database.delete(schema.projects);
    await database.delete(schema.users);
    await database.delete(schema.languages);
    await database.delete(schema.organizations);
    await database.delete(schema.bible_provider_resources);

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: `va-org-${suffix}` })
      .returning();
    orgId = org.id;
    const [language] = await db
      .insert(schema.languages)
      .values({ langName: `va-lang-${suffix}` })
      .returning();
    const [user] = await db
      .insert(schema.users)
      .values({ username: `va-user-${suffix}`, email: `va-${suffix}@example.test` })
      .returning();
    userId = user.id;
    const [project] = await db
      .insert(schema.projects)
      .values({
        name: `va-project-${suffix}`,
        sourceLanguage: language.id,
        targetLanguage: language.id,
        organization: org.id,
      })
      .returning();
    projectId = project.id;
    const [unit] = await db
      .insert(schema.project_units)
      .values({ projectId: project.id })
      .returning();
    projectUnitId = unit.id;
    await db.insert(schema.books).values({ code: 'MAT', eng_display_name: 'Matthew' });
    const [book] = await db.select().from(schema.books).where(eq(schema.books.code, 'MAT'));
    const [bible] = await db
      .insert(schema.bibles)
      .values({
        languageId: language.id,
        name: `va-bible-${suffix}`,
        abbreviation: `v${suffix.slice(0, 8)}`,
      })
      .returning();
    const [text] = await db
      .insert(schema.bible_texts)
      .values({
        bibleId: bible.id,
        bookId: book.id,
        chapterNumber: 1,
        verseNumber: 3,
        text: 'Source verse',
      })
      .returning();
    bibleTextId = text.id;

    const [storage] = await db
      .insert(schema.storage_objects)
      .values({
        bucket: 'verse-audio',
        key: `unit-${projectUnitId}/text-${bibleTextId}/hash-1`,
        createdAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning();
    storageObjectId = storage.id;

    const [recording] = await db
      .insert(schema.verse_audio_recordings)
      .values({
        projectUnitId,
        bibleTextId,
        uploadedBy: userId,
        storageObjectId,
        contentType: 'audio/mp4',
        sizeBytes: 4,
        durationSeconds: 1,
        versionToken: 2,
        conflictStatus: 'clean',
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
        activeTakeId: null,
      })
      .returning();
    recordingId = recording.id;

    const [take] = await db
      .insert(schema.verse_audio_takes)
      .values({
        recordingId,
        uploadedBy: userId,
        storageObjectId,
        contentType: 'audio/mp4',
        sizeBytes: 4,
        durationSeconds: 1,
        contentHash: 'a'.repeat(64),
        granularity: 'verse',
        startChapter: null,
        startVerse: null,
        endChapter: null,
        endVerse: null,
      })
      .returning();
    takeId = take.id;

    await db
      .update(schema.verse_audio_recordings)
      .set({ activeTakeId: takeId })
      .where(eq(schema.verse_audio_recordings.id, recordingId));
  });

  afterAll(async () => {
    await client.close();
  });

  async function insertSecondTake() {
    const [storage] = await db
      .insert(schema.storage_objects)
      .values({
        bucket: 'verse-audio',
        key: `unit-${projectUnitId}/text-${bibleTextId}/hash-2`,
        createdAt: new Date('2020-01-02T00:00:00Z'),
      })
      .returning();
    const [second] = await db
      .insert(schema.verse_audio_takes)
      .values({
        recordingId,
        uploadedBy: userId,
        storageObjectId: storage.id,
        contentType: 'audio/webm',
        sizeBytes: 8,
        durationSeconds: 2,
        contentHash: 'b'.repeat(64),
        granularity: 'verse',
        createdAt: new Date(Date.now() + 1000),
      })
      .returning();
    return { secondTakeId: second.id, secondStorageId: storage.id };
  }

  async function readRecording() {
    const [row] = await db
      .select({
        activeTakeId: schema.verse_audio_recordings.activeTakeId,
        storageObjectId: schema.verse_audio_recordings.storageObjectId,
        contentType: schema.verse_audio_recordings.contentType,
        versionToken: schema.verse_audio_recordings.versionToken,
        conflictStatus: schema.verse_audio_recordings.conflictStatus,
      })
      .from(schema.verse_audio_recordings)
      .where(eq(schema.verse_audio_recordings.id, recordingId));
    return row;
  }

  async function storageExists(id: number): Promise<boolean> {
    const [row] = await db
      .select({ id: schema.storage_objects.id })
      .from(schema.storage_objects)
      .where(eq(schema.storage_objects.id, id));
    return row !== undefined;
  }

  it('promotes the newest remaining take when the active take is deleted', async () => {
    const { secondTakeId, secondStorageId } = await insertSecondTake();

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(secondTakeId);
      expect(result.data.versionToken).toBe(3);
    }
    expect(await readRecording()).toEqual({
      activeTakeId: secondTakeId,
      storageObjectId: secondStorageId,
      contentType: 'audio/webm',
      versionToken: 3,
      conflictStatus: 'clean',
    });
    expect(deleteVerseAudio).toHaveBeenCalled();
    expect(await storageExists(storageObjectId)).toBe(false);
  });

  it('leaves the active take and versionToken alone when a non-active take is deleted', async () => {
    const { secondTakeId, secondStorageId } = await insertSecondTake();

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId: secondTakeId,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(takeId);
      expect(result.data.versionToken).toBe(2);
    }
    expect(await readRecording()).toEqual({
      activeTakeId: takeId,
      storageObjectId,
      contentType: 'audio/mp4',
      versionToken: 2,
      conflictStatus: 'clean',
    });
    expect(await storageExists(secondStorageId)).toBe(false);
  });

  it('clears the active take when the last take is deleted', async () => {
    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBeNull();
      expect(result.data.versionToken).toBe(3);
    }
    expect(await readRecording()).toEqual({
      activeTakeId: null,
      storageObjectId: null,
      contentType: 'audio/mp4',
      versionToken: 3,
      conflictStatus: 'clean',
    });
  });

  it('returns TAKE_NOT_FOUND for a take id outside this recording', async () => {
    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId: takeId + 999,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.VERSE_AUDIO_TAKE_NOT_FOUND);
    }
    expect((await readRecording())?.activeTakeId).toBe(takeId);
  });

  it('returns VERSION_CONFLICT and rolls back when baseVersionToken is stale', async () => {
    const { secondTakeId } = await insertSecondTake();

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
      baseVersionToken: 1,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
    }
    expect(await readRecording()).toEqual({
      activeTakeId: takeId,
      storageObjectId,
      contentType: 'audio/mp4',
      versionToken: 2,
      conflictStatus: 'clean',
    });
    const remaining = await takesRepo.listTakesForRecording(recordingId);
    expect(remaining.ok && remaining.data.map((t) => t.id).sort()).toEqual(
      [takeId, secondTakeId].sort()
    );
    expect(deleteVerseAudio).not.toHaveBeenCalled();
    expect(await storageExists(storageObjectId)).toBe(true);
  });

  it('promotes when baseVersionToken matches the locked version', async () => {
    const { secondTakeId } = await insertSecondTake();

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
      baseVersionToken: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(secondTakeId);
      expect(result.data.versionToken).toBe(3);
    }
  });

  it('keeps conflictStatus when promoting under conflict', async () => {
    await db
      .update(schema.verse_audio_recordings)
      .set({ conflictStatus: 'conflict' })
      .where(eq(schema.verse_audio_recordings.id, recordingId));
    const { secondTakeId } = await insertSecondTake();

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
      baseVersionToken: 2,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.activeTakeId).toBe(secondTakeId);
      expect(result.data.conflictStatus).toBe('conflict');
    }
    expect(await readRecording()).toMatchObject({
      activeTakeId: secondTakeId,
      versionToken: 3,
      conflictStatus: 'conflict',
    });
  });

  it('honours AUDIO_RECLAIM_GRACE_MS so a young orphan is left for the sweep', async () => {
    await db
      .update(schema.storage_objects)
      .set({ createdAt: new Date() })
      .where(eq(schema.storage_objects.id, storageObjectId));

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(true);
    expect(deleteVerseAudio).not.toHaveBeenCalled();
    expect(await storageExists(storageObjectId)).toBe(true);
    expect(env.AUDIO_RECLAIM_GRACE_MS).toBeGreaterThan(0);
  });

  it('rolls back the storage-row delete when the bucket callback rejects', async () => {
    vi.mocked(deleteVerseAudio).mockRejectedValueOnce(new Error('bucket unavailable'));

    const result = await deleteTake({
      projectUnitId,
      bibleTextId,
      takeId,
      actor: actor(),
      scope: scope(),
    });

    expect(result.ok).toBe(true);
    expect(await storageExists(storageObjectId)).toBe(true);
  });

  it('skips a revived claim inside the grace window', async () => {
    await db.delete(schema.verse_audio_takes);
    await db.delete(schema.verse_audio_recordings);
    await db.delete(schema.storage_objects);

    const [row] = await db
      .insert(schema.storage_objects)
      .values({
        bucket: 'verse-audio',
        key: 'unit-1/text-1/revived',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning();

    const claimed = await storageRepo.claim(row.bucket, row.key);
    expect(claimed.ok).toBe(true);

    const deleteObject = vi.fn(async () => {});
    const result = await storageRepo.reclaimOrphanIfUnreferenced(
      row.id,
      env.AUDIO_RECLAIM_GRACE_MS,
      deleteObject
    );

    expect(result).toEqual({ ok: true, data: false });
    expect(deleteObject).not.toHaveBeenCalled();
    expect(await storageExists(row.id)).toBe(true);
  });

  it('does not delete the storage row when deleteObject rejects', async () => {
    await db.delete(schema.verse_audio_takes);
    await db.delete(schema.verse_audio_recordings);
    await db.delete(schema.storage_objects);

    const [row] = await db
      .insert(schema.storage_objects)
      .values({
        bucket: 'verse-audio',
        key: 'unit-1/text-1/old-orphan',
        createdAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning();

    const result = await storageRepo.reclaimOrphanIfUnreferenced(row.id, 60_000, async () => {
      throw new Error('bucket delete failed');
    });

    expect(result.ok).toBe(false);
    expect(await storageExists(row.id)).toBe(true);
  });
});
