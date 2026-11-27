import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as projectsRepo from '@/domains/projects/projects.repository';
import { err, ErrorCode } from '@/lib/types';

import { updateChapterAssignment } from './chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

// The real services, repositories and transitions on PGlite. One test makes the project lookup
// behind touchProjectActivity fail once, to check what the update leaves behind.
const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const dbSchema = await import('@/db/schema');
  const client = new PGlite();
  return { client, database: drizzle(client, { schema: dbSchema }) };
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
vi.mock('@/domains/projects/projects.repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domains/projects/projects.repository')>();
  return { ...actual, getProjectIdByUnitId: vi.fn(actual.getProjectIdByUnitId) };
});

const PROJECT = 1;
const UNIT = 10;
const ASSIGNMENT = 1;
const DRAFTER = 5;

async function assignment() {
  const [row] = await database
    .select({
      status: schema.chapter_assignments.status,
      assignedUserId: schema.chapter_assignments.assignedUserId,
    })
    .from(schema.chapter_assignments)
    .where(eq(schema.chapter_assignments.id, ASSIGNMENT));
  return row;
}

async function history() {
  const [statuses, assignees] = await Promise.all([
    database
      .select({ status: schema.chapter_assignment_status_history.status })
      .from(schema.chapter_assignment_status_history),
    database
      .select({
        assignedUserId: schema.chapter_assignment_assigned_user_history.assignedUserId,
        role: schema.chapter_assignment_assigned_user_history.role,
      })
      .from(schema.chapter_assignment_assigned_user_history),
  ]);
  return { statuses, assignees };
}

async function lastActivityAt() {
  const [row] = await database
    .select({ lastActivityAt: schema.projects.lastActivityAt })
    .from(schema.projects)
    .where(eq(schema.projects.id, PROJECT));
  return row.lastActivityAt;
}

describe('updateChapterAssignment (PGlite)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);
    await database.insert(schema.organizations).values({ id: 1, name: 'Org' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database
      .insert(schema.users)
      .values({ id: DRAFTER, username: 'drafter', email: 'drafter@example.com' });
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
      organization: 1,
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
    await database.update(schema.projects).set({ lastActivityAt: null });
    await database.insert(schema.chapter_assignments).values({
      id: ASSIGNMENT,
      projectUnitId: UNIT,
      bibleId: 1,
      bookId: 1,
      chapterNumber: 1,
      status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
      assignedUserId: null,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  it('assigns the drafter, writes the history and stamps the project activity', async () => {
    const result = await updateChapterAssignment(ASSIGNMENT, { assignedUserId: DRAFTER });

    expect(result.ok).toBe(true);
    expect(await assignment()).toEqual({
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      assignedUserId: DRAFTER,
    });
    expect(await history()).toEqual({
      statuses: [{ status: CHAPTER_ASSIGNMENT_STATUS.DRAFT }],
      assignees: [{ assignedUserId: DRAFTER, role: 'drafter' }],
    });
    expect(await lastActivityAt()).toBeInstanceOf(Date);
  });

  it('rolls the update and its history back when the project activity cannot be stamped', async () => {
    vi.mocked(projectsRepo.getProjectIdByUnitId).mockResolvedValueOnce(
      err(ErrorCode.PROJECT_UNIT_NOT_FOUND)
    );

    const result = await updateChapterAssignment(ASSIGNMENT, { assignedUserId: DRAFTER });

    expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
    expect(await assignment()).toEqual({
      status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
      assignedUserId: null,
    });
    expect(await history()).toEqual({ statuses: [], assignees: [] });
  });
});
