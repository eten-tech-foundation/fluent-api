import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { err, ErrorCode, ok } from '@/lib/types';

import { updateTakeCoverageAndRecordingIfVersion } from './verse-audio.repository';
import { VERSE_AUDIO_GRANULARITY } from './verse-audio.types';

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

const pericopeShape = {
  granularity: VERSE_AUDIO_GRANULARITY.PERICOPE,
  startChapter: 1,
  startVerse: 3,
  endChapter: 1,
  endVerse: 8,
} as const;

/**
 * Fault-inject empty hydration after real take+recording writes inside a real
 * PGlite transaction. Under normal FK integrity the join cannot miss after a
 * successful recording update — this path is defensive. Not a production
 * concurrency / isolation proof.
 */
async function withHydrationSelectFault<T>(run: () => Promise<T>): Promise<T> {
  const originalTransaction = database.transaction.bind(database);
  database.transaction = (async (callback: Parameters<typeof database.transaction>[0]) =>
    originalTransaction(async (tx) => {
      const originalSelect = tx.select.bind(tx);
      // Fault-inject empty hydration rows; cast through unknown for the stub shape.
      tx.select = (() => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [],
            }),
          }),
        }),
      })) as unknown as typeof tx.select;
      try {
        return await callback(tx);
      } finally {
        tx.select = originalSelect;
      }
    })) as unknown as typeof database.transaction;

  try {
    return await run();
  } finally {
    database.transaction = originalTransaction;
  }
}

describe('updateTakeCoverageAndRecordingIfVersion (PGlite rollback)', () => {
  let projectUnitId: number;
  let bibleTextId: number;
  let userId: number;
  let storageObjectId: number;
  let recordingId: number;
  let takeId: number;

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
      .values({ bucket: 'verse-audio', key: `unit-${projectUnitId}/text-${bibleTextId}/hash` })
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

  async function readPersisted() {
    const [take] = await db
      .select({
        granularity: schema.verse_audio_takes.granularity,
        startChapter: schema.verse_audio_takes.startChapter,
        startVerse: schema.verse_audio_takes.startVerse,
        endChapter: schema.verse_audio_takes.endChapter,
        endVerse: schema.verse_audio_takes.endVerse,
      })
      .from(schema.verse_audio_takes)
      .where(eq(schema.verse_audio_takes.id, takeId));
    const [recording] = await db
      .select({
        versionToken: schema.verse_audio_recordings.versionToken,
        granularity: schema.verse_audio_recordings.granularity,
        startChapter: schema.verse_audio_recordings.startChapter,
        endVerse: schema.verse_audio_recordings.endVerse,
      })
      .from(schema.verse_audio_recordings)
      .where(eq(schema.verse_audio_recordings.id, recordingId));
    return { take, recording };
  }

  it('rolls back take coverage when expectedVersionToken is stale (real PGlite txn)', async () => {
    const result = await updateTakeCoverageAndRecordingIfVersion(
      takeId,
      recordingId,
      1, // stale — row is at versionToken 2
      pericopeShape,
      { versionToken: 3, ...pericopeShape }
    );

    expect(result).toEqual(ok({ applied: false, record: null }));

    const { take, recording } = await readPersisted();
    expect(take).toEqual({
      granularity: 'verse',
      startChapter: null,
      startVerse: null,
      endChapter: null,
      endVerse: null,
    });
    expect(recording?.versionToken).toBe(2);
    expect(recording?.granularity).toBe('verse');
    expect(recording?.startChapter).toBeNull();
    expect(recording?.endVerse).toBeNull();
  });

  it('rolls back real writes when hydration is fault-injected empty after CAS hit', async () => {
    const result = await withHydrationSelectFault(() =>
      updateTakeCoverageAndRecordingIfVersion(takeId, recordingId, 2, pericopeShape, {
        versionToken: 3,
        ...pericopeShape,
      })
    );

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));

    const { take, recording } = await readPersisted();
    expect(take).toEqual({
      granularity: 'verse',
      startChapter: null,
      startVerse: null,
      endChapter: null,
      endVerse: null,
    });
    expect(recording?.versionToken).toBe(2);
    expect(recording?.granularity).toBe('verse');
  });

  it('persists take coverage and recording version when CAS hits (control)', async () => {
    const result = await updateTakeCoverageAndRecordingIfVersion(
      takeId,
      recordingId,
      2,
      pericopeShape,
      { versionToken: 3, ...pericopeShape }
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.applied).toBe(true);
      expect(result.data.record?.versionToken).toBe(3);
      expect(result.data.record?.granularity).toBe('pericope');
      expect(result.data.record?.endVerse).toBe(8);
    }

    const { take, recording } = await readPersisted();
    expect(take).toEqual({
      granularity: 'pericope',
      startChapter: 1,
      startVerse: 3,
      endChapter: 1,
      endVerse: 8,
    });
    expect(recording?.versionToken).toBe(3);
  });
});
