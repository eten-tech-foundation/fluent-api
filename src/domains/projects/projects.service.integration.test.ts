import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import * as chapterAssignmentsService from '@/domains/chapter-assignments/chapter-assignments.service';
import { getQueue } from '@/lib/queue';
import { err, ErrorCode, ok } from '@/lib/types';

import { createProject, touchProjectActivity } from './projects.service';
import * as usfmImportService from './usfm-import.service';

// The real projects service and repository on PGlite, inside real transactions, so a failed
// creation is checked against the rows the database kept. createProject reads source data
// through `db` while its transaction is open, hence joinOpenTransaction.
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
vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
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
  createChapterAssignmentForProjectUnit: vi.fn(),
}));

const MARK = 41;
const LUKE = 42;

const PROJECT = {
  name: 'New project',
  isActive: true,
  sourceLanguage: 1,
  targetLanguage: 2,
  sourceBibleId: 1,
  organization: 1,
  createdBy: 1,
};

const FILES = [
  { fileName: 'luk.usfm', bookCode: 'LUK', usfm: '\\id LUK\n\\c 1\n\\v 1 Luke.' },
  { fileName: 'mrk.usfm', bookCode: 'MRK', usfm: '\\id MRK\n\\c 1\n\\v 1 Mark.' },
];

async function rowCounts() {
  const [projects, units, links, imports, stages] = await Promise.all([
    database.select().from(schema.projects),
    database.select().from(schema.project_units),
    database.select().from(schema.project_unit_bible_books),
    database.select().from(schema.project_unit_usfm_imports),
    database.select().from(schema.project_workflow_stages),
  ]);
  return {
    projects: projects.length,
    units: units.length,
    links: links.length,
    imports: imports.length,
    stages: stages.length,
  };
}

const NOTHING = { projects: 0, units: 0, links: 0, imports: 0, stages: 0 };

describe('projects service (PGlite)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);
    await database
      .insert(schema.users)
      .values({ id: 1, username: 'manager', email: 'manager@example.com' });
    await database.insert(schema.organizations).values({ id: 1, name: 'Test organization' });
    await database.insert(schema.languages).values([
      { id: 1, langName: 'English' },
      { id: 2, langName: 'Gujarati' },
    ]);
    await database.insert(schema.books).values([
      { id: MARK, code: 'MRK', eng_display_name: 'Mark' },
      { id: LUKE, code: 'LUK', eng_display_name: 'Luke' },
    ]);
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Source Bible',
      abbreviation: 'SRC',
      provider: 'dbl',
    });
    await database.insert(schema.bible_books).values([
      { bibleId: 1, bookId: MARK },
      { bibleId: 1, bookId: LUKE },
    ]);
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    await database.delete(schema.projects);
    vi.mocked(getQueue).mockResolvedValue({ send: vi.fn() } as never);
    vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
      ok([])
    );
  });

  afterAll(async () => {
    await client.close();
  });

  describe('createProject', () => {
    it('writes nothing when the chapter assignments cannot be created', async () => {
      vi.mocked(chapterAssignmentsService.createChapterAssignmentForProjectUnit).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const result = await createProject({ ...PROJECT, bibleId: 1, bookId: [MARK] });

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      // The project, its stages, the milestone and its book were written before this step.
      expect(
        chapterAssignmentsService.createChapterAssignmentForProjectUnit
      ).toHaveBeenCalledOnce();
      expect(await rowCounts()).toEqual(NOTHING);
    });

    it('writes nothing for an import whose ingestion job cannot be queued', async () => {
      vi.mocked(usfmImportService.parseUsfmFiles).mockResolvedValue(
        ok([
          { ...FILES[0], bookId: LUKE, verses: [] },
          { ...FILES[1], bookId: MARK, verses: [] },
        ])
      );
      const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
      vi.mocked(getQueue).mockResolvedValue({ send } as never);

      const result = await createProject({ ...PROJECT, usfmFiles: FILES });

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      // The files were stored with the project before the job was queued.
      expect(send).toHaveBeenCalledOnce();
      expect(await rowCounts()).toEqual(NOTHING);
      expect(usfmImportService.materializePendingUsfmImports).not.toHaveBeenCalled();
    });

    it('keeps the import when its ingestion job is queued', async () => {
      vi.mocked(usfmImportService.parseUsfmFiles).mockResolvedValue(
        ok([{ ...FILES[1], bookId: MARK, verses: [] }])
      );
      vi.mocked(usfmImportService.materializePendingUsfmImports).mockResolvedValue(
        ok({ materialized: 0, pending: 1 })
      );

      const result = await createProject({ ...PROJECT, usfmFiles: [FILES[1]] });

      expect(result.ok).toBe(true);
      expect(await rowCounts()).toMatchObject({ projects: 1, units: 1, links: 1, imports: 1 });
    });
  });

  describe('touchProjectActivity', () => {
    async function insertProjectWithUnit() {
      const [project] = await database
        .insert(schema.projects)
        .values({ name: 'Active project', sourceLanguage: 1, targetLanguage: 2, organization: 1 })
        .returning();
      const [unit] = await database
        .insert(schema.project_units)
        .values({ projectId: project.id, name: 'Mark' })
        .returning();
      return { projectId: project.id, unitId: unit.id };
    }

    async function lastActivityAt(projectId: number) {
      const [row] = await database
        .select({ lastActivityAt: schema.projects.lastActivityAt })
        .from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      return row.lastActivityAt;
    }

    it("stamps the activity time on the unit's project", async () => {
      const { projectId, unitId } = await insertProjectWithUnit();
      expect(await lastActivityAt(projectId)).toBeNull();

      const result = await database.transaction((tx) => touchProjectActivity(unitId, tx));

      expect(result).toEqual(ok(undefined));
      expect(await lastActivityAt(projectId)).toBeInstanceOf(Date);
    });

    it('returns INTERNAL_ERROR and stamps nothing for a unit that does not exist', async () => {
      const { projectId } = await insertProjectWithUnit();

      const result = await database.transaction((tx) => touchProjectActivity(999_999, tx));

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(await lastActivityAt(projectId)).toBeNull();
    });
  });
});
