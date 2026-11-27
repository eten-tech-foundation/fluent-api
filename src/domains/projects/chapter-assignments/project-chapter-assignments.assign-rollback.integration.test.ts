import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as chapterAssignmentsRepo from '@/domains/chapter-assignments/chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import * as projectsRepo from '@/domains/projects/projects.repository';
import { err, ErrorCode, ok } from '@/lib/types';

import {
  assignAllProjectChapterAssignmentsToUser,
  assignSelectedChapters,
} from './project-chapter-assignments.service';

// Both bulk assigns update chapter after chapter in one transaction. When the second update
// fails, the first one must not stay behind. It fails in one of two ways: the project lookup
// behind touchProjectActivity errors, or the chapter is gone by the time it is updated.
// Everything else is the real service on PGlite. The project and its users are read through
// `db` while the transaction is open, hence joinOpenTransaction.
const { client, database, serviceDb } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const dbSchema = await import('@/db/schema');
  const { joinOpenTransaction } = await import('@/db/testing/pglite-open-transaction');
  const client = new PGlite();
  const database = drizzle(client, { schema: dbSchema });
  return { client, database, serviceDb: joinOpenTransaction(database) };
});

vi.mock('@/db', () => ({ db: serviceDb }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/ai-suggestions/ai-suggestions.service', () => ({
  handleChapterAssigned: vi.fn(),
}));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));
vi.mock('@/domains/projects/projects.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domains/projects/projects.repository')>();
  return { ...actual, getProjectIdByUnitId: vi.fn(actual.getProjectIdByUnitId) };
});
vi.mock('@/domains/chapter-assignments/chapter-assignments.repository', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/domains/chapter-assignments/chapter-assignments.repository')
    >();
  return { ...actual, update: vi.fn(actual.update) };
});

const ORG = 1;
const PROJECT = 1;
const UNIT = 10;
const DRAFTER = 5;
const NEW_DRAFTER = 6;

async function assignments() {
  return database
    .select({
      id: schema.chapter_assignments.id,
      status: schema.chapter_assignments.status,
      assignedUserId: schema.chapter_assignments.assignedUserId,
    })
    .from(schema.chapter_assignments)
    .orderBy(asc(schema.chapter_assignments.id));
}

async function historyRows() {
  const [statuses, assignees] = await Promise.all([
    database.select().from(schema.chapter_assignment_status_history),
    database.select().from(schema.chapter_assignment_assigned_user_history),
  ]);
  return statuses.length + assignees.length;
}

const BEFORE = [
  { id: 1, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT, assignedUserId: DRAFTER },
  { id: 2, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT, assignedUserId: DRAFTER },
];

function failSecondActivityStamp() {
  vi.mocked(projectsRepo.getProjectIdByUnitId)
    .mockResolvedValueOnce(ok({ projectId: PROJECT }))
    .mockResolvedValueOnce(err(ErrorCode.PROJECT_UNIT_NOT_FOUND));
}

/** The second chapter's update finds no row, as when the chapter is deleted mid-request. */
function loseSecondChapter() {
  const update = vi.mocked(chapterAssignmentsRepo.update);
  const real = update.getMockImplementation();
  if (!real) throw new Error('update mock has no implementation');
  update.mockImplementationOnce(real).mockResolvedValueOnce(null);
}

describe('bulk chapter assigning rollback (PGlite)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);
    await database.insert(schema.organizations).values({ id: ORG, name: 'Org' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.users).values([
      { id: DRAFTER, username: 'drafter', email: 'drafter@example.com' },
      { id: NEW_DRAFTER, username: 'new-drafter', email: 'new-drafter@example.com' },
    ]);
    const [role] = await database.insert(schema.roles).values({ name: 'Org Member' }).returning();
    await database
      .insert(schema.user_roles)
      .values({ userId: NEW_DRAFTER, orgId: ORG, projectId: null, roleId: role.id });
    await database.insert(schema.books).values({ id: 1, code: 'GEN', eng_display_name: 'Genesis' });
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Test Bible',
      abbreviation: 'TST',
      provider: 'dbl',
    });
    await database.insert(schema.projects).values({
      id: PROJECT,
      name: 'Project',
      sourceLanguage: 1,
      targetLanguage: 1,
      organization: ORG,
    });
    await database
      .insert(schema.project_units)
      .values({ id: UNIT, projectId: PROJECT, name: 'Genesis', type: 'text' });
    await database
      .insert(schema.project_unit_bible_books)
      .values({ projectUnitId: UNIT, bibleId: 1, bookId: 1 });
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await database.delete(schema.chapter_assignment_status_history);
    await database.delete(schema.chapter_assignment_assigned_user_history);
    await database.delete(schema.chapter_assignments);
    await database.insert(schema.chapter_assignments).values(
      [1, 2].map((chapterNumber) => ({
        id: chapterNumber,
        projectUnitId: UNIT,
        bibleId: 1,
        bookId: 1,
        chapterNumber,
        status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        assignedUserId: DRAFTER,
      }))
    );
  });

  afterAll(async () => {
    await client.close();
  });

  it('assignSelectedChapters keeps every chapter as it was when one update fails', async () => {
    failSecondActivityStamp();

    const result = await assignSelectedChapters(PROJECT, [
      { chapterAssignmentId: 1, drafterId: NEW_DRAFTER, peerCheckerId: null },
      { chapterAssignmentId: 2, drafterId: NEW_DRAFTER, peerCheckerId: null },
    ]);

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(projectsRepo.getProjectIdByUnitId).toHaveBeenCalledTimes(2);
    expect(await assignments()).toEqual(BEFORE);
    expect(await historyRows()).toBe(0);
  });

  it('assignAllProjectChapterAssignmentsToUser keeps every chapter as it was when one update fails', async () => {
    failSecondActivityStamp();

    const result = await assignAllProjectChapterAssignmentsToUser(PROJECT, {
      assignedUserId: NEW_DRAFTER,
    });

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(projectsRepo.getProjectIdByUnitId).toHaveBeenCalledTimes(2);
    expect(await assignments()).toEqual(BEFORE);
    expect(await historyRows()).toBe(0);
  });

  it('assignSelectedChapters keeps the first chapter as it was when the second one is gone', async () => {
    loseSecondChapter();

    const result = await assignSelectedChapters(PROJECT, [
      { chapterAssignmentId: 1, drafterId: NEW_DRAFTER, peerCheckerId: null },
      { chapterAssignmentId: 2, drafterId: NEW_DRAFTER, peerCheckerId: null },
    ]);

    expect(result).toEqual(err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND));
    expect(await assignments()).toEqual(BEFORE);
    expect(await historyRows()).toBe(0);
  });

  it('assignAllProjectChapterAssignmentsToUser keeps the first chapter as it was when the second one is gone', async () => {
    loseSecondChapter();

    const result = await assignAllProjectChapterAssignmentsToUser(PROJECT, {
      assignedUserId: NEW_DRAFTER,
    });

    expect(result).toEqual(err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND));
    expect(await assignments()).toEqual(BEFORE);
    expect(await historyRows()).toBe(0);
  });

  it('assignSelectedChapters reassigns every chapter when the updates succeed', async () => {
    const result = await assignSelectedChapters(PROJECT, [
      { chapterAssignmentId: 1, drafterId: NEW_DRAFTER, peerCheckerId: null },
      { chapterAssignmentId: 2, drafterId: NEW_DRAFTER, peerCheckerId: null },
    ]);

    expect(result.ok).toBe(true);
    expect(await assignments()).toEqual([
      { id: 1, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT, assignedUserId: NEW_DRAFTER },
      { id: 2, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT, assignedUserId: NEW_DRAFTER },
    ]);
  });
});
