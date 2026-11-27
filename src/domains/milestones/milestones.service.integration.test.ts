import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { err, ErrorCode } from '@/lib/types';

import { createMilestone, updateMilestone } from './milestones.service';

// The real milestones service, repository and chapter-assignments service on PGlite, so a
// rejected write is checked against the rows the database kept. Only the queue and the logger
// are stubbed.
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
vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn().mockResolvedValue({ send: vi.fn() }),
  QUEUE_NAMES: { DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority' },
}));

const PROJECT = 1;
const OTHER_PROJECT = 2;
const MILESTONE = 10;
const OTHER_PROJECT_MILESTONE = 20;
const BIBLE = 1;
const GENESIS = 1;
const EXODUS = 2;

async function milestones() {
  return database
    .select({
      id: schema.project_units.id,
      projectId: schema.project_units.projectId,
      name: schema.project_units.name,
    })
    .from(schema.project_units)
    .orderBy(asc(schema.project_units.id));
}

async function bookLinks() {
  return database
    .select({
      projectUnitId: schema.project_unit_bible_books.projectUnitId,
      bookId: schema.project_unit_bible_books.bookId,
    })
    .from(schema.project_unit_bible_books)
    .orderBy(asc(schema.project_unit_bible_books.bookId));
}

describe('milestones service rollback (PGlite)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);
    await database.insert(schema.organizations).values({ id: 1, name: 'Org' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.books).values([
      { id: GENESIS, code: 'GEN', eng_display_name: 'Genesis' },
      { id: EXODUS, code: 'EXO', eng_display_name: 'Exodus' },
    ]);
    await database.insert(schema.bibles).values({
      id: BIBLE,
      languageId: 1,
      name: 'Source Bible',
      abbreviation: 'SRC',
      provider: 'dbl',
    });
    await database.insert(schema.bible_books).values([
      { bibleId: BIBLE, bookId: GENESIS },
      { bibleId: BIBLE, bookId: EXODUS },
    ]);
    await database.insert(schema.projects).values([
      { id: PROJECT, name: 'Project', sourceLanguage: 1, targetLanguage: 1, organization: 1 },
      { id: OTHER_PROJECT, name: 'Other', sourceLanguage: 1, targetLanguage: 1, organization: 1 },
    ]);
  }, 30_000);

  beforeEach(async () => {
    await database.delete(schema.project_unit_bible_books);
    await database.delete(schema.project_units);
    await database.insert(schema.project_units).values([
      { id: MILESTONE, projectId: PROJECT, name: 'Genesis', type: 'text' },
      { id: OTHER_PROJECT_MILESTONE, projectId: OTHER_PROJECT, name: 'Elsewhere', type: 'text' },
    ]);
    await database
      .insert(schema.project_unit_bible_books)
      .values({ projectUnitId: MILESTONE, bibleId: BIBLE, bookId: GENESIS });
  });

  afterAll(async () => {
    await client.close();
  });

  it('leaves no milestone behind when one of its books is already in another milestone', async () => {
    // The milestone row is inserted before the duplicate-book check runs.
    const result = await createMilestone(PROJECT, BIBLE, {
      name: 'Genesis again',
      type: 'text',
      status: 'not_started',
      bookIds: [EXODUS, GENESIS],
    });

    expect(result).toEqual(err(ErrorCode.VALIDATION_ERROR));
    expect(await milestones()).toEqual([
      { id: MILESTONE, projectId: PROJECT, name: 'Genesis' },
      { id: OTHER_PROJECT_MILESTONE, projectId: OTHER_PROJECT, name: 'Elsewhere' },
    ]);
    expect(await bookLinks()).toEqual([{ projectUnitId: MILESTONE, bookId: GENESIS }]);
  });

  it('keeps the old name when a book move targets a milestone of another project', async () => {
    // The rename is written before the move is checked.
    const result = await updateMilestone(
      PROJECT,
      MILESTONE,
      {
        name: 'Renamed',
        moveBooks: [{ bookId: GENESIS, targetMilestoneId: OTHER_PROJECT_MILESTONE }],
      },
      BIBLE
    );

    expect(result).toEqual(err(ErrorCode.FORBIDDEN));
    expect(await milestones()).toEqual([
      { id: MILESTONE, projectId: PROJECT, name: 'Genesis' },
      { id: OTHER_PROJECT_MILESTONE, projectId: OTHER_PROJECT, name: 'Elsewhere' },
    ]);
    expect(await bookLinks()).toEqual([{ projectUnitId: MILESTONE, bookId: GENESIS }]);
  });

  it('keeps the old name when a book being moved is not in the milestone', async () => {
    const result = await updateMilestone(
      PROJECT,
      MILESTONE,
      { name: 'Renamed', moveBooks: [{ bookId: EXODUS, targetMilestoneId: MILESTONE }] },
      BIBLE
    );

    expect(result).toEqual(err(ErrorCode.INVALID_BIBLE_BOOKS));
    const [milestone] = await database
      .select({ name: schema.project_units.name })
      .from(schema.project_units)
      .where(eq(schema.project_units.id, MILESTONE));
    expect(milestone.name).toBe('Genesis');
  });
});
