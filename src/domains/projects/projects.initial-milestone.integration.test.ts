import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { ok } from '@/lib/types';

import { createProject } from './projects.service';
import * as usfmImportService from './usfm-import.service';

// The real createProject and repository against PGlite, so the initial milestone's name is read
// back from the database. The queue, the USFM parser and chapter assignments are stubbed: they
// are covered elsewhere and do not decide the name.
const { client, database, serviceDb } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const dbSchema = await import('@/db/schema');
  const client = new PGlite();
  const database = drizzle(client, { schema: dbSchema });
  // PGlite has a single connection. createProject reads committed source data through `db`
  // while its transaction is open, which would wait on that transaction forever here, so the
  // callback runs on the same connection instead. Every statement is still real SQL.
  const serviceDb = new Proxy(database, {
    get(target, prop) {
      if (prop === 'transaction')
        return (callback: (tx: typeof target) => unknown) => callback(target);
      const value: unknown = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { client, database, serviceDb };
});

vi.mock('@/db', () => ({ db: serviceDb }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn().mockResolvedValue({ send: vi.fn() }),
  QUEUE_NAMES: {
    DBL_INGEST_TEXT: 'dbl-ingest-text',
    DBL_INGEST_TEXT_PRIORITY: 'dbl-ingest-text-priority',
    USFM_IMPORT_MATERIALIZE: 'usfm-import-materialize',
  },
}));
vi.mock('./usfm-import.service', () => ({
  parseUsfmFiles: vi.fn(),
  materializePendingUsfmImports: vi.fn(),
}));
vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  createChapterAssignmentForProjectUnit: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

const FILES = [
  { fileName: 'luk.usfm', bookCode: 'LUK', usfm: '\\id LUK\n\\c 1\n\\v 1 Luke.' },
  { fileName: 'mrk.usfm', bookCode: 'MRK', usfm: '\\id MRK\n\\c 1\n\\v 1 Mark.' },
];

const PROJECT = {
  name: 'Imported project',
  isActive: true,
  sourceLanguage: 1,
  targetLanguage: 2,
  sourceBibleId: 1,
  organization: 1,
  createdBy: 1,
};

async function milestoneNames(projectId: number) {
  const units = await database
    .select({ name: schema.project_units.name })
    .from(schema.project_units)
    .where(eq(schema.project_units.projectId, projectId));
  return units.map((unit) => unit.name);
}

describe('the milestone created with a project', () => {
  beforeAll(async () => {
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema)
    );
    await client.exec(statements.join('\n'));
    await database
      .insert(schema.users)
      .values({ id: 1, username: 'manager', email: 'manager@example.com' });
    await database.insert(schema.organizations).values({ id: 1, name: 'Test organization' });
    await database.insert(schema.languages).values([
      { id: 1, langName: 'English' },
      { id: 2, langName: 'Gujarati' },
    ]);
    await database.insert(schema.books).values([
      { id: 19, code: 'PSA', eng_display_name: 'Psalms' },
      { id: 41, code: 'MRK', eng_display_name: 'Mark' },
      { id: 42, code: 'LUK', eng_display_name: 'Luke' },
    ]);
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Source Bible',
      abbreviation: 'SRC',
      provider: 'dbl',
    });
    await database.insert(schema.bible_books).values([
      { bibleId: 1, bookId: 19 },
      { bibleId: 1, bookId: 41 },
      { bibleId: 1, bookId: 42 },
    ]);
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await database.delete(schema.projects);
  });

  afterAll(async () => {
    await client.close();
  });

  it('is named after the imported books, in book order', async () => {
    vi.mocked(usfmImportService.parseUsfmFiles).mockResolvedValue(
      ok([
        { ...FILES[0], bookId: 42, verses: [] },
        { ...FILES[1], bookId: 41, verses: [] },
      ])
    );
    vi.mocked(usfmImportService.materializePendingUsfmImports).mockResolvedValue(
      ok({ materialized: 0, pending: 2 })
    );

    const result = await createProject({ ...PROJECT, usfmFiles: FILES });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await milestoneNames(result.data.id)).toEqual(['Mark, Luke']);
  });

  it('is named after the books of a legacy book request', async () => {
    const result = await createProject({ ...PROJECT, bibleId: 1, bookId: [19] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await milestoneNames(result.data.id)).toEqual(['Psalms']);
  });

  it('is not created for a project without books', async () => {
    const result = await createProject(PROJECT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await milestoneNames(result.data.id)).toEqual([]);
  });
});
