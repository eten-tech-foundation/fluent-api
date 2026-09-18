import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { pericope_verses } from '@/db/schema';
import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import { asAuthenticatedUser, MOCK_PROJECT } from './pericopes.test-fixtures';

import '@/domains/pericopes/pericopes.route';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

// Database-backed integration pattern documented in ARCHITECTURE.md.
// Swap only the connection; Drizzle, repository queries, and PostgreSQL stay real.
vi.mock('@/db', () => ({ db: database }));
vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/domains/projects/projects.service', () => ({ getProjectById: vi.fn() }));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

const CROSS_CHAPTER_GROUP = {
  pericopeNumber: '20',
  pericopeTitle: 'Jesus predicts his death',
  verses: [
    { chapterNumber: 8, verseNumber: 31 },
    { chapterNumber: 8, verseNumber: 32 },
    { chapterNumber: 8, verseNumber: 33 },
    { chapterNumber: 8, verseNumber: 34 },
    { chapterNumber: 8, verseNumber: 35 },
    { chapterNumber: 8, verseNumber: 36 },
    { chapterNumber: 8, verseNumber: 37 },
    { chapterNumber: 8, verseNumber: 38 },
    { chapterNumber: 9, verseNumber: 1 },
  ],
};

describe('chapter pericopes with real PostgreSQL queries', () => {
  beforeAll(async () => {
    // Generate tables, constraints, and indexes from the production schema so
    // this fixture cannot silently retain obsolete handwritten DDL.
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        pericope_verses: schema.pericope_verses,
        pericope_sets: schema.pericope_sets,
        books: schema.books,
        projects: schema.projects,
        projectAssignmentStatusEnum: schema.projectAssignmentStatusEnum,
        languages: schema.languages,
        scriptDirectionEnum: schema.scriptDirectionEnum,
        organizations: schema.organizations,
        users: schema.users,
        userStatusEnum: schema.userStatusEnum,
        authUser: schema.authUser,
        authSession: schema.authSession,
      })
    );
    await client.exec(statements.join('\n'));
    await database.insert(schema.books).values([
      { id: 41, code: 'MRK', eng_display_name: 'Mark' },
      { id: 42, code: 'LUK', eng_display_name: 'Luke' },
    ]);
    await database.insert(schema.pericope_sets).values([
      { id: 1, name: 'FIA' },
      { id: 2, name: 'FCBH' },
      { id: 3, name: 'Other set' },
    ]);
    await database.insert(schema.languages).values({ id: 1, langName: 'English' });
    await database.insert(schema.organizations).values({ id: 1, name: 'Test organization' });
    await database.insert(schema.projects).values(
      [1, 2, null].map((pericopeSetId, index) => ({
        id: 10 + index,
        name: `Test project ${index}`,
        sourceLanguage: 1,
        targetLanguage: 1,
        organization: 1,
        pericopeSetId,
      }))
    );
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    asAuthenticatedUser();
    vi.mocked(getProjectById).mockResolvedValue(ok(MOCK_PROJECT));
    vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
    await database.delete(pericope_verses);
    // Insert in reverse order: the response must follow Scripture order,
    // including chapter before verse, regardless of storage order.
    await database.insert(pericope_verses).values([
      ...CROSS_CHAPTER_GROUP.verses.toReversed().map((verse) => ({
        ...verse,
        pericopeSetId: 1,
        bookId: 41,
        section: null,
        pericopeNumber: '20',
        pericopeTitle: 'Jesus predicts his death',
      })),
      // Same identity in another book/set must not extend the selected group.
      { pericopeSetId: 1, bookId: 42, chapterNumber: 8, verseNumber: 39, pericopeNumber: '20' },
      { pericopeSetId: 2, bookId: 41, chapterNumber: 8, verseNumber: 40, pericopeNumber: '20' },
      // Adjacent groups must not appear unless they intersect this chapter.
      { pericopeSetId: 1, bookId: 41, chapterNumber: 9, verseNumber: 2, pericopeNumber: '21' },
      { pericopeSetId: 1, bookId: 41, chapterNumber: 8, verseNumber: 30, pericopeNumber: '19' },
      // Matching numbers intersecting chapter 9 in another book/set must not
      // pull groups from chapter 10 into this project's response.
      { pericopeSetId: 1, bookId: 41, chapterNumber: 10, verseNumber: 1, pericopeNumber: '22' },
      { pericopeSetId: 1, bookId: 42, chapterNumber: 9, verseNumber: 3, pericopeNumber: '22' },
      { pericopeSetId: 1, bookId: 41, chapterNumber: 10, verseNumber: 2, pericopeNumber: '23' },
      { pericopeSetId: 3, bookId: 41, chapterNumber: 9, verseNumber: 3, pericopeNumber: '23' },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it.each([
    [8, 'true'],
    [9, 'true'],
    [8, '1'],
    [9, '1'],
  ] as const)('returns all of Mark 8:31–9:1 from chapter %i with %s', async (chapter, value) => {
    const res = await server.request(
      `/projects/10/pericopes/MRK/${chapter}?includeFullPericopes=${value}`
    );

    expect(res.status).toBe(200);
    const adjacent = {
      pericopeNumber: chapter === 8 ? '19' : '21',
      pericopeTitle: null,
      verses: [{ chapterNumber: chapter, verseNumber: chapter === 8 ? 30 : 2 }],
    };
    expect(await res.json()).toEqual(
      chapter === 8 ? [adjacent, CROSS_CHAPTER_GROUP] : [CROSS_CHAPTER_GROUP, adjacent]
    );
  });

  it.each(['', '?includeFullPericopes=false', '?includeFullPericopes=0'])(
    'keeps chapter-only references for the default/false option (%s)',
    async (query) => {
      const res = await server.request(`/projects/10/pericopes/MRK/9${query}`);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        {
          pericopeNumber: '20',
          pericopeTitle: 'Jesus predicts his death',
          verses: [{ chapterNumber: 9, verseNumber: 1 }],
        },
        {
          pericopeNumber: '21',
          pericopeTitle: null,
          verses: [{ chapterNumber: 9, verseNumber: 2 }],
        },
      ]);
    }
  );

  it('selects and groups FCBH pericopes by section as well as pericope number', async () => {
    await database.insert(pericope_verses).values([
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 10,
        verseNumber: 1,
        section: 6,
        pericopeNumber: '1',
      },
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 9,
        verseNumber: 2,
        section: 6,
        pericopeNumber: '1',
      },
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 9,
        verseNumber: 1,
        section: 5,
        pericopeNumber: '1',
      },
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 8,
        verseNumber: 38,
        section: 5,
        pericopeNumber: '1',
      },
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 11,
        verseNumber: 1,
        section: 7,
        pericopeNumber: '1',
      },
      {
        pericopeSetId: 2,
        bookId: 41,
        chapterNumber: 12,
        verseNumber: 1,
        section: null,
        pericopeNumber: '1',
      },
    ]);

    const res = await server.request('/projects/11/pericopes/MRK/9?includeFullPericopes=true');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        pericopeNumber: '5_1',
        pericopeTitle: null,
        verses: [
          { chapterNumber: 8, verseNumber: 38 },
          { chapterNumber: 9, verseNumber: 1 },
        ],
      },
      {
        pericopeNumber: '6_1',
        pericopeTitle: null,
        verses: [
          { chapterNumber: 9, verseNumber: 2 },
          { chapterNumber: 10, verseNumber: 1 },
        ],
      },
    ]);
  });

  it.each(['/projects/12/pericopes/MRK/9', '/projects/10/pericopes/MRK/3'])(
    'preserves the empty fallback for %s',
    async (path) => {
      const res = await server.request(`${path}?includeFullPericopes=true`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    }
  );

  it.each(['maybe', 'TRUE', ''])(
    'rejects an invalid full-pericope query value (%s)',
    async (value) => {
      const res = await server.request(
        `/projects/10/pericopes/MRK/9?includeFullPericopes=${value}`
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        success: false,
        error: { issues: expect.any(Array) },
      });
    }
  );

  it('documents the accepted query strings before their boolean transform', () => {
    const document = server.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'Pericope test', version: '1' },
    });
    const operation = document.paths['/projects/{id}/pericopes/{bookCode}/{chapter}']?.get;
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({
        name: 'includeFullPericopes',
        in: 'query',
        required: false,
        schema: expect.objectContaining({ type: 'string', enum: ['true', 'false', '1', '0'] }),
      })
    );
  });
});
