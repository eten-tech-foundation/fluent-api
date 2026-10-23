import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { VERSE_AUDIO_CONFLICT_STATUS } from '@/domains/verse-audio/verse-audio.types';

import { CHAPTER_ASSIGNMENT_STATUS } from '../chapter-assignments.types';
import * as progressRepo from './chapter-assignments-progress.repository';

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

describe('chapter-assignments-progress repository (PGlite integration)', () => {
  let projectId: number;
  let projectUnitId: number;
  let bibleId: number;
  let bookId: number;
  let chapterAssignmentId: number;

  beforeAll(async () => {
    await createTestSchema(client, {
      organizations: schema.organizations,
      languages: schema.languages,
      users: schema.users,
      projects: schema.projects,
      pericope_sets: schema.pericope_sets,
      project_units: schema.project_units,
      books: schema.books,
      bible_provider_resources: schema.bible_provider_resources,
      bibles: schema.bibles,
      project_unit_bible_books: schema.project_unit_bible_books,
      chapter_assignments: schema.chapter_assignments,
      bible_texts: schema.bible_texts,
      translated_verses: schema.translated_verses,
      storage_objects: schema.storage_objects,
      verse_audio_recordings: schema.verse_audio_recordings,
      verse_audio_takes: schema.verse_audio_takes,
      authUser: schema.authUser,
      authSession: schema.authSession,
      bibleProviderEnum: schema.bibleProviderEnum,
      resourceProviderEnum: schema.resourceProviderEnum,
      ttsLicenseStatusEnum: schema.ttsLicenseStatusEnum,
      scriptDirectionEnum: schema.scriptDirectionEnum,
      projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
      verseAudioConflictStatusEnum: schema.verseAudioConflictStatusEnum,
      userStatusEnum: schema.userStatusEnum,
      milestoneTypeEnum: schema.milestoneTypeEnum,
      projectStatusEnum: schema.projectStatusEnum,
    });

    const [org] = await database
      .insert(schema.organizations)
      .values({ name: 'Test Org' })
      .returning();

    const [lang] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();

    const [user] = await database
      .insert(schema.users)
      .values({ username: 'testuser', email: 'test@example.com' })
      .returning();

    const [checker] = await database
      .insert(schema.users)
      .values({ username: 'checkeruser', email: 'checker@example.com' })
      .returning();

    const [project] = await database
      .insert(schema.projects)
      .values({
        name: 'Test Project',
        organization: org.id,
        sourceLanguage: lang.id,
        targetLanguage: lang.id,
      })
      .returning();
    projectId = project.id;

    const [unit] = await database.insert(schema.project_units).values({ projectId }).returning();
    projectUnitId = unit.id;

    const [book] = await database
      .insert(schema.books)
      .values({ code: 'JHN', eng_display_name: 'John' })
      .returning();
    bookId = book.id;

    const [, audioResource] = await database
      .insert(schema.bible_provider_resources)
      .values([
        {
          provider: 'dbl',
          externalId: 'opaque-text-ID',
          ttsLicenseStatus: 'allowed',
        },
        {
          provider: 'aquifer',
          externalId: 'res-rec-1',
          ttsLicenseStatus: 'unknown',
        },
      ])
      .returning();

    const [bible] = await database
      .insert(schema.bibles)
      .values({
        name: 'Test Bible',
        abbreviation: 'TB',
        languageId: lang.id,
        provider: 'dbl',
        externalId: 'opaque-text-ID',
        audioResourceId: audioResource.id,
      })
      .returning();
    bibleId = bible.id;

    await database.insert(schema.project_unit_bible_books).values({
      projectUnitId,
      bibleId,
      bookId,
    });

    const [assignment] = await database
      .insert(schema.chapter_assignments)
      .values({
        projectUnitId,
        bibleId,
        bookId,
        chapterNumber: 3,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        assignedUserId: user.id,
        peerCheckerId: checker.id,
        isAiEnabled: false,
      })
      .returning();
    chapterAssignmentId = assignment.id;

    const [text1, text2] = await database
      .insert(schema.bible_texts)
      .values([
        { bibleId, bookId, chapterNumber: 3, verseNumber: 1, text: 'Verse 1' },
        { bibleId, bookId, chapterNumber: 3, verseNumber: 2, text: 'Verse 2' },
      ])
      .returning();

    await database.insert(schema.translated_verses).values([
      { projectUnitId, bibleTextId: text1.id, content: 'Translated 1' },
      { projectUnitId, bibleTextId: text2.id, content: '' },
    ]);

    await database.insert(schema.verse_audio_recordings).values({
      projectUnitId,
      bibleTextId: text1.id,
      uploadedBy: user.id,
      contentType: 'audio/mp4',
      sizeBytes: 100,
      conflictStatus: VERSE_AUDIO_CONFLICT_STATUS.CONFLICT,
    });
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it('surfaces assignment progress, counts, keys, and hasConflict from real PostgreSQL', async () => {
    const result = await progressRepo.findAssignmentsProgress({ projectId });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveLength(1);
    const row = result.data[0];
    expect(row).toMatchObject({
      assignmentId: chapterAssignmentId,
      projectId,
      projectName: 'Test Project',
      projectUnitId,
      bibleId,
      bibleName: 'Test Bible',
      ttsLicenseStatus: 'allowed',
      textBibleKey: 'dbl-opaque-text-ID',
      selectedRecordingKey: 'aq-res-rec-1',
      bookId,
      bookCode: 'JHN',
      bookNameEng: 'John',
      chapterNumber: 3,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      targetLanguage: 'English',
      targetLangCode: 'eng',
      sourceLangCode: 'eng',
      totalVerses: 2,
      completedVerses: 1,
      assignedUserDisplayName: 'testuser',
      peerCheckerDisplayName: 'checkeruser',
      hasConflict: true,
    });
  });

  it('filters by non-matching projectId and returns empty array', async () => {
    const result = await progressRepo.findAssignmentsProgress({ projectId: 9999 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual([]);
  });
});
