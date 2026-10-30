import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { createTestSchema } from '@/db/testing/create-catalogue-schema';
import { asAuthenticatedUser } from '@/domains/pericopes/pericopes.test-fixtures';
import * as usfmImportService from '@/domains/projects/usfm-import.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { getQueue, QUEUE_NAMES } from '@/lib/queue';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import './milestone-usfm-import.route';

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
vi.mock('@/lib/queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/queue')>()),
  getQueue: vi.fn(),
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/domains/projects/usfm-import.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/domains/projects/usfm-import.service')>();
  return { ...actual, prepareUsfmImport: vi.fn(actual.prepareUsfmImport) };
});

const INGESTED = new Date('2026-09-01T00:00:00Z');
const GEN_NO_ID =
  '\\h Genesis\n\\toc3 Gn\n\\mt1 Genesis\n\\c 1\n\\p\n\\v 1 In the beginning.\n\\v 2 The earth.\n';
// \zcustom is a tag Fluent knows nothing about: the stored file must keep it (#419).
const LUK = '\\id LUK\n\\zcustom keep me\n\\c 1\n\\p\n\\v 1 Luke one.\n';
const send = vi.fn();

const post = (path: string, body: unknown) =>
  server.request(`/projects/10/milestones/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

async function seedProject() {
  await database.insert(schema.projects).values({
    id: 10,
    name: 'Kachi Koli NT',
    organization: 1,
    sourceLanguage: 1,
    targetLanguage: 1,
    sourceBibleId: 1,
  });
  await database.insert(schema.project_units).values([
    { id: 100, projectId: 10, name: 'Gospels' },
    { id: 101, projectId: 10, name: 'Torah' },
  ]);
  await database.insert(schema.project_unit_bible_books).values([
    { projectUnitId: 100, bibleId: 1, bookId: 41 },
    // Exodus was removed from its milestone; the project still holds its content.
    { projectUnitId: 101, bibleId: 1, bookId: 2, deletedAt: INGESTED },
  ]);
}

const units = () => database.select().from(schema.project_units).orderBy(schema.project_units.id);

describe('milestone USFM import (#418, #419, #420)', () => {
  beforeAll(async () => {
    await createTestSchema(client, schema);
    await database.insert(schema.users).values({ id: 1, username: 'pm', email: 'pm@example.com' });
    await database.insert(schema.organizations).values({ id: 1, name: 'Test organization' });
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.books).values([
      { id: 1, code: 'GEN', eng_display_name: 'Genesis' },
      { id: 2, code: 'EXO', eng_display_name: 'Exodus' },
      { id: 41, code: 'MRK', eng_display_name: 'Mark' },
      { id: 42, code: 'LUK', eng_display_name: 'Luke' },
      { id: 43, code: 'JHN', eng_display_name: 'John' },
    ]);
    await database.insert(schema.bibles).values({
      id: 1,
      languageId: 1,
      name: 'Source Bible',
      abbreviation: 'SRC',
      provider: 'dbl',
    });
    // John is not in the source Bible; Luke is, but its text is not ingested yet.
    await database.insert(schema.bible_books).values([
      { bibleId: 1, bookId: 1, textIngestedAt: INGESTED },
      { bibleId: 1, bookId: 2, textIngestedAt: INGESTED },
      { bibleId: 1, bookId: 41, textIngestedAt: INGESTED },
      { bibleId: 1, bookId: 42 },
    ]);
    await database.insert(schema.bible_texts).values([
      { id: 1, bibleId: 1, bookId: 1, chapterNumber: 1, verseNumber: 1, text: 'Source one.' },
      { id: 2, bibleId: 1, bookId: 1, chapterNumber: 1, verseNumber: 2, text: 'Source two.' },
    ]);
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    asAuthenticatedUser();
    vi.mocked(findGrantsByUserId).mockResolvedValue(
      ok([
        {
          orgId: 1,
          projectId: null,
          permissions: new Set([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_UPDATE]),
        },
      ])
    );
    send.mockResolvedValue('job-1');
    vi.mocked(getQueue).mockResolvedValue({ send } as unknown as Awaited<
      ReturnType<typeof getQueue>
    >);
    await database.delete(schema.projects);
    await seedProject();
  });

  afterAll(async () => {
    await client.close();
  });

  it('POST usfm-validation gives each file a verdict against the project', async () => {
    const res = await post('usfm-validation', {
      listedBookCodes: ['LUK'],
      files: [
        { fileName: 'GEN.usfm', usfm: GEN_NO_ID },
        { fileName: 'MRK.usfm', usfm: '\\id MRK\n\\c 1\n\\p\n\\v 1 x' },
        { fileName: 'EXO.usfm', usfm: '\\id EXO\n\\c 1\n\\p\n\\v 1 x' },
        { fileName: 'JHN.usfm', usfm: '\\id JHN\n\\c 1\n\\p\n\\v 1 x' },
        { fileName: 'LUK-again.usfm', usfm: LUK },
        { fileName: 'notes.txt', usfm: 'just notes' },
      ],
    });

    expect(res.status).toBe(200);
    const { files } = await res.json();
    expect(files.map((f: { ok: boolean; message?: string }) => (f.ok ? 'ok' : f.message))).toEqual([
      'ok',
      'Mark already exists in Gospels.',
      'Exodus already exists in this project.',
      'John is not in Source Bible.',
      'Luke was already added.',
      'File is not a valid USFM file.',
    ]);
    expect(files[0]).toEqual({
      fileName: 'GEN.usfm',
      ok: true,
      bookCode: 'GEN',
      bookName: 'Genesis',
    });
    expect(await units()).toHaveLength(2);
  });

  it('POST import creates one milestone from the files and keeps every tag', async () => {
    const res = await post('import', {
      name: 'Beginnings',
      files: [
        { fileName: 'GEN.usfm', usfm: GEN_NO_ID },
        { fileName: 'LUK.usfm', usfm: LUK },
      ],
    });

    expect(res.status).toBe(201);
    const milestone = await res.json();
    expect(milestone).toMatchObject({ name: 'Beginnings', projectId: 10, bookIds: [1, 42] });

    const imports = await database
      .select()
      .from(schema.project_unit_usfm_imports)
      .where(eq(schema.project_unit_usfm_imports.projectUnitId, milestone.id))
      .orderBy(schema.project_unit_usfm_imports.bookId);
    expect(imports.map((row) => [row.fileName, row.usfm, row.materializedAt !== null])).toEqual([
      ['GEN.usfm', GEN_NO_ID, true],
      ['LUK.usfm', LUK, false],
    ]);
    const verses = await database
      .select()
      .from(schema.translated_verses)
      .where(eq(schema.translated_verses.projectUnitId, milestone.id))
      .orderBy(schema.translated_verses.bibleTextId);
    expect(verses.map((row) => row.content)).toEqual(['In the beginning.', 'The earth.']);
    // Genesis has source text, so its chapters are assignable; Luke waits for ingestion.
    const assignments = await database
      .select()
      .from(schema.chapter_assignments)
      .where(eq(schema.chapter_assignments.projectUnitId, milestone.id));
    expect(assignments.map((row) => [row.bookId, row.chapterNumber])).toEqual([[1, 1]]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      QUEUE_NAMES.DBL_INGEST_TEXT_PRIORITY,
      { bibleId: 1, bookCodes: ['LUK'], projectUnitId: milestone.id },
      { priority: 10 }
    );
  });

  it('POST import creates nothing when a file is refused, and lists every verdict', async () => {
    const res = await post('import', {
      name: 'Mixed',
      files: [
        { fileName: 'GEN.usfm', usfm: GEN_NO_ID },
        { fileName: 'MRK.usfm', usfm: '\\id MRK\n\\c 1\n\\p\n\\v 1 x' },
      ],
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.message).toBe('One or more files cannot be imported');
    expect(body.files[1]).toMatchObject({ error: 'USFM_BOOK_EXISTS', milestoneName: 'Gospels' });
    expect(await units()).toHaveLength(2);
    expect(send).not.toHaveBeenCalled();
  });

  it('POST import rolls everything back when ingestion cannot be queued', async () => {
    send.mockRejectedValue(new Error('queue down'));

    const res = await post('import', {
      name: 'Luke',
      files: [{ fileName: 'LUK.usfm', usfm: LUK }],
    });

    expect(res.status).toBe(500);
    expect(await units()).toHaveLength(2);
    expect(await database.select().from(schema.project_unit_usfm_imports)).toEqual([]);
  });

  it('POST import answers 409 when the project gained the book after the check', async () => {
    // The check passed (say, just before another tab added Mark to a milestone)...
    vi.mocked(usfmImportService.prepareUsfmImport).mockResolvedValueOnce(
      ok({
        verdicts: [{ fileName: 'MRK.usfm', ok: true, bookCode: 'MRK', bookName: 'Mark' }],
        accepted: [
          {
            fileName: 'MRK.usfm',
            usfm: '\\id MRK\n\\c 1\n\\p\n\\v 1 x',
            bookCode: 'MRK',
            bookId: 41,
            verses: [{ chapterNumber: 1, verseNumber: 1, text: 'x' }],
          },
        ],
      })
    );

    const res = await post('import', {
      name: 'Late',
      files: [{ fileName: 'MRK.usfm', usfm: '\\id MRK\n\\c 1\n\\p\n\\v 1 x' }],
    });

    // ...but the project lock sees Mark in Gospels and nothing is created.
    expect(res.status).toBe(409);
    expect(await units()).toHaveLength(2);
  });

  it.each(['usfm-validation', 'import'])('POST %s requires a signed-in user', async (path) => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const res = await post(path, { name: 'x', files: [{ fileName: 'a.usfm', usfm: LUK }] });

    expect(res.status).toBe(401);
  });

  it('POST import refuses an empty name', async () => {
    const res = await post('import', { name: '   ', files: [{ fileName: 'LUK.usfm', usfm: LUK }] });

    expect(res.status).toBe(400);
    expect(await units()).toHaveLength(2);
  });
});
