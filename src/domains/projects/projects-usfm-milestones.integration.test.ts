import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@/lib/types';

import * as schema from '@/db/schema';
import { moveBookToMilestone } from '@/domains/milestones/milestones.repository';
import { asAuthenticatedUser } from '@/domains/pericopes/pericopes.test-fixtures';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getRoleId, grantRole } from '@/domains/user-roles/user-roles.service';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import { getPendingUsfmImportsForBible } from './projects.repository';
import { createProject } from './projects.service';
import { materializePendingUsfmImportsForBible } from './usfm-import.service';
import './projects.route';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.service', () => ({
  getRoleId: vi.fn(),
  grantRole: vi.fn(),
}));
vi.mock('./projects.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./projects.service')>()),
  // Start at the committed creation boundary; rollback and its cascades stay real.
  createProject: vi.fn(),
}));

const RAW_USFM = '\\id MRK\n\\c 1\n\\p\n\\v 1 Imported verse.\n';
const MATERIALIZED_AT = new Date('2026-09-01T00:00:00Z');

async function seedProject() {
  const [project] = await database
    .insert(schema.projects)
    .values({
      id: 10,
      name: 'Imported project',
      organization: 1,
      sourceLanguage: 1,
      targetLanguage: 1,
      sourceBibleId: 1,
    })
    .returning();
  await database.insert(schema.project_units).values([
    { id: 100, projectId: 10, name: 'Original milestone' },
    { id: 101, projectId: 10, name: 'Target milestone' },
  ]);
  await database.insert(schema.project_unit_bible_books).values({
    projectUnitId: 100,
    bibleId: 1,
    bookId: 41,
  });
  await database.insert(schema.chapter_assignments).values({
    projectUnitId: 100,
    bibleId: 1,
    bookId: 41,
    chapterNumber: 1,
  });
  return project;
}

async function seedImport(projectUnitId: number, bookId = 41, materializedAt: Date | null = null) {
  const [row] = await database
    .insert(schema.project_unit_usfm_imports)
    .values({ projectUnitId, bookId, fileName: `${bookId}.usfm`, usfm: RAW_USFM, materializedAt })
    .returning();
  return row;
}

function moveBook() {
  return database.transaction((tx) =>
    moveBookToMilestone(41, 100, 101, tx as unknown as DbTransaction)
  );
}

describe('imported USFM across project rollback and milestone moves', () => {
  beforeAll(async () => {
    // Use the production constraints, including import uniqueness and cascade deletes.
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema)
    );
    await client.exec(statements.join('\n'));
    await database
      .insert(schema.users)
      .values({ id: 1, username: 'translator', email: 'translator@example.com' });
    await database.insert(schema.organizations).values({ id: 1, name: 'Test organization' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.books).values([
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
    await database
      .insert(schema.bible_books)
      .values({ bibleId: 1, bookId: 41, textIngestedAt: MATERIALIZED_AT });
    await database.insert(schema.bible_texts).values({
      id: 1,
      bibleId: 1,
      bookId: 41,
      chapterNumber: 1,
      verseNumber: 1,
      text: 'Source verse.',
    });
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    asAuthenticatedUser();
    vi.mocked(findGrantsByUserId).mockResolvedValue(
      ok([
        {
          orgId: 1,
          projectId: null,
          permissions: new Set([
            PERMISSIONS.PROJECT_CREATE,
            PERMISSIONS.PROJECT_DELETE,
            PERMISSIONS.PROJECT_VIEW,
          ]),
        },
      ])
    );
    vi.mocked(getRoleId).mockResolvedValue(1);
    await database.delete(schema.projects);
  });

  afterAll(async () => {
    await client.close();
  });

  it.each([false, true])(
    'rolls back a created project with initial milestones (USFM: %s) after role failure',
    async (hasImport) => {
      const project = await seedProject();
      if (hasImport) await seedImport(100);
      vi.mocked(createProject).mockResolvedValue(ok(project));
      vi.mocked(grantRole).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

      const res = await server.request('/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: project.name,
          organization: 1,
          sourceLanguage: 1,
          targetLanguage: 1,
          ...(hasImport
            ? {
                sourceBibleId: 1,
                usfmFiles: [{ fileName: 'MRK.usfm', bookCode: 'MRK', usfm: RAW_USFM }],
              }
            : { bibleId: 1, bookId: [41] }),
        }),
      });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        message: 'Project created but failed to assign creator role. Rolled back.',
      });
      expect(await database.select().from(schema.projects)).toEqual([]);
      expect(await database.select().from(schema.project_units)).toEqual([]);
      expect(await database.select().from(schema.project_unit_bible_books)).toEqual([]);
      expect(await database.select().from(schema.chapter_assignments)).toEqual([]);
      expect(await database.select().from(schema.project_unit_usfm_imports)).toEqual([]);
    }
  );

  it('keeps the normal DELETE guard for a project with milestones', async () => {
    await seedProject();
    const imported = await seedImport(100);

    const res = await server.request('/projects/10', { method: 'DELETE' });

    expect(res.status).toBe(409);
    expect(await database.select().from(schema.projects)).toHaveLength(1);
    expect(await database.select().from(schema.project_units)).toHaveLength(2);
    expect(await database.select().from(schema.project_unit_usfm_imports)).toEqual([imported]);
  });

  it.each([null, MATERIALIZED_AT])(
    'moves an import with materializedAt=%s and preserves its raw file after deleting the old milestone',
    async (materializedAt) => {
      await seedProject();
      const imported = await seedImport(100, 41, materializedAt);
      const otherBook = await seedImport(100, 42, MATERIALIZED_AT);
      await database
        .insert(schema.project_units)
        .values({ id: 102, projectId: 10, name: 'Unrelated milestone' });
      const otherMilestone = await seedImport(102, 41, MATERIALIZED_AT);
      if (materializedAt) {
        await database
          .insert(schema.translated_verses)
          .values({ projectUnitId: 100, bibleTextId: 1, content: 'Imported verse.' });
      }

      await moveBook();

      const imports = await database
        .select()
        .from(schema.project_unit_usfm_imports)
        .orderBy(schema.project_unit_usfm_imports.id);
      expect(imports).toEqual([{ ...imported, projectUnitId: 101 }, otherBook, otherMilestone]);
      expect(await getPendingUsfmImportsForBible(1, [41])).toEqual(
        materializedAt
          ? []
          : [
              {
                id: imported.id,
                projectUnitId: 101,
                bookId: 41,
                usfm: RAW_USFM,
              },
            ]
      );
      await database.delete(schema.project_units).where(eq(schema.project_units.id, 100));
      expect(await materializePendingUsfmImportsForBible(1, [41])).toEqual(
        ok({ materialized: materializedAt ? 0 : 1, pending: 0 })
      );
      expect(await database.select().from(schema.translated_verses)).toEqual([
        expect.objectContaining({ projectUnitId: 101, bibleTextId: 1, content: 'Imported verse.' }),
      ]);
      const [preserved] = await database
        .select()
        .from(schema.project_unit_usfm_imports)
        .where(eq(schema.project_unit_usfm_imports.id, imported.id));
      expect(preserved).toEqual({
        ...imported,
        projectUnitId: 101,
        materializedAt: expect.any(Date),
      });
      expect(await database.select().from(schema.chapter_assignments)).toEqual([
        expect.objectContaining({ projectUnitId: 101, bookId: 41 }),
      ]);
    }
  );

  it('rolls back every move when the destination already owns an import for the book', async () => {
    await seedProject();
    const original = await seedImport(100);
    const destination = await seedImport(101, 41, MATERIALIZED_AT);
    await database
      .insert(schema.translated_verses)
      .values({ projectUnitId: 100, bibleTextId: 1, content: 'Existing translation.' });
    const links = await database.select().from(schema.project_unit_bible_books);
    const assignments = await database.select().from(schema.chapter_assignments);
    const verses = await database.select().from(schema.translated_verses);

    await expect(moveBook()).rejects.toMatchObject({
      cause: { code: '23505', constraint: 'uq_usfm_import_per_unit_book' },
    });

    expect(await database.select().from(schema.project_unit_bible_books)).toEqual(links);
    expect(await database.select().from(schema.chapter_assignments)).toEqual(assignments);
    expect(await database.select().from(schema.translated_verses)).toEqual(verses);
    expect(
      await database
        .select()
        .from(schema.project_unit_usfm_imports)
        .orderBy(schema.project_unit_usfm_imports.id)
    ).toEqual([original, destination]);
  });
});
