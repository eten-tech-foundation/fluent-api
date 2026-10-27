import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as chapterAssignmentRepo from '@/domains/chapter-assignments/chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { ErrorCode } from '@/lib/types';

import { resetSelectedChapters } from './project-chapter-assignments.service';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const schemaMod = await import('@/db/schema');
  const client = new PGlite();
  return { client, database: drizzle(client, { schema: schemaMod }) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/ai-suggestions/ai-suggestions.service', () => ({
  handleChapterAssigned: vi.fn(),
}));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

describe('resetSelectedChapters (PGlite)', () => {
  let projectId: number;
  let projectUnitId: number;
  let bibleId: number;
  let bookId: number;
  let drafterId: number;
  let peerId: number;
  let claimerId: number;
  let draftId: number;
  let peerCheckId: number;
  let completeId: number;

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
      chapter_assignment_status_history: schema.chapter_assignment_status_history,
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
      verseAudioGranularityEnum: schema.verseAudioGranularityEnum,
      userStatusEnum: schema.userStatusEnum,
      milestoneTypeEnum: schema.milestoneTypeEnum,
      projectStatusEnum: schema.projectStatusEnum,
    });

    const [org] = await database
      .insert(schema.organizations)
      .values({ name: 'Reset Org' })
      .returning();
    const [lang] = await database
      .insert(schema.languages)
      .values({ langName: 'English', langCodeIso6393: 'eng' })
      .returning();
    const [drafter, peer, claimer] = await database
      .insert(schema.users)
      .values([
        { username: 'drafter', email: 'drafter@example.com' },
        { username: 'peer', email: 'peer@example.com' },
        { username: 'claimer', email: 'claimer@example.com' },
      ])
      .returning();
    drafterId = drafter.id;
    peerId = peer.id;
    claimerId = claimer.id;

    const [project] = await database
      .insert(schema.projects)
      .values({
        name: 'Reset Project',
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
      .values({ code: 'MAT', eng_display_name: 'Matthew' })
      .returning();
    bookId = book.id;

    await database.insert(schema.bible_provider_resources).values({
      provider: 'dbl',
      externalId: 'reset-text-id',
      ttsLicenseStatus: 'allowed',
    });

    const [bible] = await database
      .insert(schema.bibles)
      .values({
        name: 'Reset Bible',
        abbreviation: 'RST',
        languageId: lang.id,
        provider: 'dbl',
        externalId: 'reset-text-id',
      })
      .returning();
    bibleId = bible.id;

    await database.insert(schema.project_unit_bible_books).values({
      projectUnitId,
      bibleId,
      bookId,
    });

    await database.insert(schema.bible_texts).values([
      { bibleId, bookId, chapterNumber: 1, verseNumber: 1, text: 'v1' },
      { bibleId, bookId, chapterNumber: 2, verseNumber: 1, text: 'v1' },
      { bibleId, bookId, chapterNumber: 3, verseNumber: 1, text: 'v1' },
    ]);
  }, 30_000);

  beforeEach(async () => {
    await database.delete(schema.chapter_assignment_status_history);
    await database.delete(schema.chapter_assignments);

    const [draft, peerCheck, complete] = await database
      .insert(schema.chapter_assignments)
      .values([
        {
          projectUnitId,
          bibleId,
          bookId,
          chapterNumber: 1,
          status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
          assignedUserId: drafterId,
          peerCheckerId: null,
          submittedTime: null,
        },
        {
          projectUnitId,
          bibleId,
          bookId,
          chapterNumber: 2,
          status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK,
          assignedUserId: drafterId,
          peerCheckerId: peerId,
          submittedTime: new Date('2026-01-15T12:00:00.000Z'),
        },
        {
          projectUnitId,
          bibleId,
          bookId,
          chapterNumber: 3,
          status: CHAPTER_ASSIGNMENT_STATUS.COMPLETE,
          assignedUserId: drafterId,
          peerCheckerId: peerId,
          submittedTime: new Date('2026-01-16T12:00:00.000Z'),
        },
      ])
      .returning();
    draftId = draft.id;
    peerCheckId = peerCheck.id;
    completeId = complete.id;
  });

  afterAll(async () => {
    await client.close();
  });

  it('resets draft and peer_check, writes status history, and allows re-claim', async () => {
    const result = await resetSelectedChapters(projectId, [draftId, peerCheckId]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rows = await database
      .select()
      .from(schema.chapter_assignments)
      .where(inArray(schema.chapter_assignments.id, [draftId, peerCheckId]))
      .orderBy(schema.chapter_assignments.id);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED);
      expect(row.assignedUserId).toBeNull();
      expect(row.peerCheckerId).toBeNull();
      expect(row.submittedTime).toBeNull();
    }

    const history = await database
      .select()
      .from(schema.chapter_assignment_status_history)
      .where(
        inArray(schema.chapter_assignment_status_history.chapterAssignmentId, [
          draftId,
          peerCheckId,
        ])
      );
    expect(history).toHaveLength(2);
    expect(history.every((h) => h.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED)).toBe(true);

    const claimed = await database.transaction((tx) =>
      chapterAssignmentRepo.claimIfUnassigned(draftId, claimerId, tx)
    );
    expect(claimed.claimed).toBe(true);
    expect(claimed.record?.assignedUserId).toBe(claimerId);
    expect(claimed.record?.status).toBe(CHAPTER_ASSIGNMENT_STATUS.DRAFT);
  });

  it('returns 409 for complete and leaves every row unchanged', async () => {
    const before = await database
      .select()
      .from(schema.chapter_assignments)
      .orderBy(schema.chapter_assignments.id);

    const result = await resetSelectedChapters(projectId, [draftId, completeId]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CHAPTER_ASSIGNMENT_NOT_RESETTABLE);

    const after = await database
      .select()
      .from(schema.chapter_assignments)
      .orderBy(schema.chapter_assignments.id);
    expect(after).toEqual(before);

    const history = await database
      .select()
      .from(schema.chapter_assignment_status_history)
      .where(
        and(
          eq(schema.chapter_assignment_status_history.chapterAssignmentId, draftId),
          eq(schema.chapter_assignment_status_history.status, CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED)
        )
      );
    expect(history).toHaveLength(0);
  });
});
