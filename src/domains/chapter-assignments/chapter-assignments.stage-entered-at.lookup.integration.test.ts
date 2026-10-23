import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';

import * as repo from './chapter-assignments.repository';
import { getStageEnteredAtByAssignmentIds } from './chapter-assignments.stage-entered-at.lookup';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

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

describe('stageEnteredAt lookup (PGlite SQL)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);

    await database.insert(schema.organizations).values({ id: 1, name: 'Org' });
    await database.insert(schema.languages).values([
      { id: 1, langName: 'English', langCodeIso6393: 'eng' },
      { id: 2, langName: 'Spanish', langCodeIso6393: 'spa' },
    ]);
    await database.insert(schema.books).values({ id: 41, code: 'MRK', eng_display_name: 'Mark' });
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Source',
      abbreviation: 'SRC',
      provider: 'dbl',
    });
    await database.insert(schema.users).values({
      id: 1,
      username: 'u',
      email: 'u@example.com',
    });
    await database.insert(schema.projects).values({
      id: 1,
      name: 'P',
      organization: 1,
      sourceLanguage: 1,
      targetLanguage: 2,
      sourceBibleId: 1,
    });
    await database.insert(schema.project_units).values({ id: 1, projectId: 1, name: 'M1' });
    await database.insert(schema.project_unit_bible_books).values({
      projectUnitId: 1,
      bibleId: 1,
      bookId: 41,
    });
  });

  beforeEach(async () => {
    await database.delete(schema.chapter_assignment_status_history);
    await database.delete(schema.chapter_assignments);
  });

  afterAll(async () => {
    await client.close();
  });

  async function insertAssignment(id: number, status: string) {
    await database.insert(schema.chapter_assignments).values({
      id,
      projectUnitId: 1,
      bibleId: 1,
      bookId: 41,
      chapterNumber: id,
      status,
    });
  }

  it('batches history for many assignments in one query and resolves entry/re-entry/null/mismatch', async () => {
    await insertAssignment(1, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await insertAssignment(2, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await insertAssignment(3, CHAPTER_ASSIGNMENT_STATUS.DRAFT);
    await insertAssignment(4, CHAPTER_ASSIGNMENT_STATUS.DRAFT);

    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t2 = new Date('2026-01-02T00:00:00.000Z');
    const t3 = new Date('2026-01-03T00:00:00.000Z');
    const t4 = new Date('2026-01-04T00:00:00.000Z');
    const tie = new Date('2026-01-05T00:00:00.000Z');

    // 1: current entry
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 1, status: 'draft', createdAt: t1 },
      { chapterAssignmentId: 1, status: 'peer_check', createdAt: t2 },
    ]);

    // 2: re-entry after leaving peer_check
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 2, status: 'draft', createdAt: t1 },
      { chapterAssignmentId: 2, status: 'peer_check', createdAt: t2 },
      { chapterAssignmentId: 2, status: 'community_review', createdAt: t3 },
      { chapterAssignmentId: 2, status: 'peer_check', createdAt: t4 },
    ]);

    // 3: latest history mismatches current status
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 3, status: 'draft', createdAt: t1 },
      { chapterAssignmentId: 3, status: 'peer_check', createdAt: t2 },
    ]);

    // 4: no history rows (missing) — leave empty

    // 5: same-status repeats + createdAt ties (id order)
    await insertAssignment(5, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 5, status: 'draft', createdAt: tie },
      { chapterAssignmentId: 5, status: 'peer_check', createdAt: tie },
      { chapterAssignmentId: 5, status: 'peer_check', createdAt: tie },
    ]);

    // 6: null createdAt on sole matching row
    await insertAssignment(6, CHAPTER_ASSIGNMENT_STATUS.DRAFT);
    await database.insert(schema.chapter_assignment_status_history).values({
      chapterAssignmentId: 6,
      status: 'draft',
      createdAt: null,
    });

    const historyById = await repo.findStatusHistoryByAssignmentIds([1, 2, 3, 4, 5, 6]);
    expect(historyById.get(1)?.map((r) => r.status)).toEqual(['draft', 'peer_check']);
    expect(historyById.get(4)).toEqual([]);

    const resolved = await getStageEnteredAtByAssignmentIds([
      { id: 1, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 2, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 3, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
      { id: 4, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
      { id: 5, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 6, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
    ]);

    expect(resolved.get(1)).toBe('2026-01-02T00:00:00.000Z');
    expect(resolved.get(2)).toBe('2026-01-04T00:00:00.000Z');
    expect(resolved.get(3)).toBeNull(); // mismatch
    expect(resolved.get(4)).toBeNull(); // missing history
    expect(resolved.get(5)).toBe('2026-01-05T00:00:00.000Z'); // start of trailing same-status run
    expect(resolved.get(6)).toBeNull(); // null createdAt
  });

  it('returns null for mixed-null history (does not invent entry via NULLS LAST)', async () => {
    const t1 = new Date('2026-01-01T00:00:00.000Z');
    const t3 = new Date('2026-01-03T00:00:00.000Z');

    // Parent gap: draft(id1,t1), peer_check(id2,null), peer_check(id3,t3) → null
    await insertAssignment(20, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 20, status: 'draft', createdAt: t1 },
      { chapterAssignmentId: 20, status: 'peer_check', createdAt: null },
      { chapterAssignmentId: 20, status: 'peer_check', createdAt: t3 },
    ]);

    // null before dated same-status
    await insertAssignment(21, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 21, status: 'peer_check', createdAt: null },
      { chapterAssignmentId: 21, status: 'peer_check', createdAt: t3 },
    ]);

    // null after dated same-status
    await insertAssignment(22, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 22, status: 'peer_check', createdAt: t1 },
      { chapterAssignmentId: 22, status: 'peer_check', createdAt: null },
    ]);

    // null on different prior status
    await insertAssignment(23, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 23, status: 'draft', createdAt: null },
      { chapterAssignmentId: 23, status: 'peer_check', createdAt: t3 },
    ]);

    // null on later different status
    await insertAssignment(24, CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK);
    await database.insert(schema.chapter_assignment_status_history).values([
      { chapterAssignmentId: 24, status: 'peer_check', createdAt: t1 },
      { chapterAssignmentId: 24, status: 'community_review', createdAt: null },
    ]);

    const resolved = await getStageEnteredAtByAssignmentIds([
      { id: 20, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 21, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 22, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 23, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
      { id: 24, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
    ]);

    expect(resolved.get(20)).toBeNull();
    expect(resolved.get(21)).toBeNull();
    expect(resolved.get(22)).toBeNull();
    expect(resolved.get(23)).toBeNull();
    expect(resolved.get(24)).toBeNull();
  });

  it('does not invent stageEnteredAt from assignment timestamps when history is absent', async () => {
    await database.insert(schema.chapter_assignments).values({
      id: 10,
      projectUnitId: 1,
      bibleId: 1,
      bookId: 41,
      chapterNumber: 10,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
      updatedAt: new Date('2020-06-01T00:00:00.000Z'),
      submittedTime: new Date('2020-07-01T00:00:00.000Z'),
    });

    const resolved = await getStageEnteredAtByAssignmentIds([
      { id: 10, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
    ]);
    expect(resolved.get(10)).toBeNull();
  });
});
