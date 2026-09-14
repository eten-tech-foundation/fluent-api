import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { pericope_verses } from '@/db/schema';
import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { ok } from '@/lib/types';
import { server } from '@/server/server';
import '@/domains/pericopes/pericopes.route';

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
    // Only the tables used by the real repository are needed. Auth boundaries
    // stay mocked; chapter selection, SQL null matching and grouping stay real.
    await client.exec(`
      CREATE TABLE projects (id integer PRIMARY KEY, pericope_set_id integer);
      CREATE TABLE books (id integer PRIMARY KEY, code varchar(50) NOT NULL);
      CREATE TABLE auth_session (id text PRIMARY KEY, active_org_id integer);
      CREATE TABLE pericope_verses (
        id serial PRIMARY KEY,
        pericope_set_id integer NOT NULL,
        book_id integer NOT NULL,
        chapter_number integer NOT NULL,
        verse_number integer NOT NULL,
        section integer,
        pericope_number varchar(20) NOT NULL,
        pericope_title varchar(500),
        UNIQUE (pericope_set_id, book_id, chapter_number, verse_number)
      );
      INSERT INTO books VALUES (41, 'MRK'), (42, 'LUK');
      INSERT INTO projects VALUES (10, 1), (11, 2), (12, NULL);
    `);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    (auth.api.getSession as any).mockResolvedValue({
      session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
      user: { email: 'translator@example.com' },
    });
    (getUserByEmail as any).mockResolvedValue(
      ok({ id: 1, email: 'translator@example.com', organization: 1, status: 'verified' })
    );
    (findGrantsByUserId as any).mockResolvedValue(
      ok([{ orgId: null, projectId: null, permissions: new Set(['project:view']) }])
    );
    (getProjectById as any).mockResolvedValue(ok({ id: 10, name: 'Test', organization: 1 }));
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

  it.each([8, 9])(
    'returns all of Mark 8:31–9:1 from chapter %i when requested',
    async (chapter) => {
      const res = await server.request(
        `/projects/10/pericopes/MRK/${chapter}?includeFullPericopes=true`
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
    }
  );

  it.each(['', '?includeFullPericopes=false'])(
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

  it('rejects an invalid full-pericope query value', async () => {
    const res = await server.request('/projects/10/pericopes/MRK/9?includeFullPericopes=maybe');
    expect(res.status).toBe(400);
  });
});
