import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/db/schema';
import { pericope_verses } from '@/db/schema';
import env from '@/env';
import { auth } from '@/lib/auth';
import { server } from '@/server/server';

import { asAuthenticatedSetUser } from './pericope-sets.test-fixtures';

import '@/domains/pericopes/pericopes.route';

const { client, database } = await vi.hoisted(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const client = new PGlite();
  return { client, database: drizzle(client) };
});

// Keep the repository SQL, service, routes, and authentication middleware real.
// Only replace the database connection and external identity boundaries.
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

const MARK_GROUP = {
  bookCode: 'MRK',
  pericopeNumber: '20',
  pericopeTitle: 'Jesus predicts his death',
  verses: [
    { chapterNumber: 8, verseNumber: 31 },
    { chapterNumber: 8, verseNumber: 32 },
    { chapterNumber: 9, verseNumber: 1 },
  ],
};

const ALL_GROUPS = [
  MARK_GROUP,
  {
    bookCode: 'MRK',
    pericopeNumber: '21',
    pericopeTitle: null,
    verses: [{ chapterNumber: 9, verseNumber: 2 }],
  },
  {
    bookCode: 'LUK',
    pericopeNumber: '20',
    pericopeTitle: 'A different book',
    verses: [{ chapterNumber: 1, verseNumber: 1 }],
  },
];

const SET_ONE_ROWS = [
  ...MARK_GROUP.verses.map((verse) => ({
    ...verse,
    pericopeSetId: 1,
    bookId: 41,
    pericopeNumber: '20',
    pericopeTitle: MARK_GROUP.pericopeTitle,
  })),
  {
    pericopeSetId: 1,
    bookId: 41,
    chapterNumber: 9,
    verseNumber: 2,
    pericopeNumber: '21',
  },
  {
    pericopeSetId: 1,
    bookId: 42,
    chapterNumber: 1,
    verseNumber: 1,
    pericopeNumber: '20',
    pericopeTitle: 'A different book',
  },
];

describe('pericope set sync with real PostgreSQL queries', () => {
  beforeAll(async () => {
    // Generate tables and constraints from the current production schema.
    const statements = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson({
        pericope_verses: schema.pericope_verses,
        pericope_sets: schema.pericope_sets,
        books: schema.books,
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
      { id: 43, code: 'JHN', eng_display_name: 'John' },
    ]);
    await database.insert(schema.pericope_sets).values([
      { id: 1, name: 'FIA' },
      { id: 2, name: 'FCBH' },
      { id: 3, name: 'Empty set' },
    ]);
  }, 30_000);

  beforeEach(async () => {
    vi.clearAllMocks();
    asAuthenticatedSetUser();
    await database.delete(pericope_verses);
    await database.insert(pericope_verses).values([
      // Deliberately insert backwards to exercise SQL ordering.
      ...SET_ONE_ROWS.toReversed(),
      { pericopeSetId: 2, bookId: 41, chapterNumber: 8, verseNumber: 30, pericopeNumber: '20' },
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it('returns complete cross-chapter groups in book/chapter/verse order and isolates sets', async () => {
    const res = await server.request('/pericope-sets/1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALL_GROUPS);
  });

  it('keeps repeated pericope numbers separate by FCBH section and book', async () => {
    await database.insert(pericope_verses).values([
      {
        pericopeSetId: 2,
        bookId: 42,
        chapterNumber: 1,
        verseNumber: 1,
        section: 5,
        pericopeNumber: '1',
      },
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
    ]);

    const res = await server.request('/pericope-sets/2');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      {
        bookCode: 'MRK',
        pericopeNumber: '20',
        pericopeTitle: null,
        verses: [{ chapterNumber: 8, verseNumber: 30 }],
      },
      {
        bookCode: 'MRK',
        pericopeNumber: '5_1',
        pericopeTitle: null,
        verses: [
          { chapterNumber: 8, verseNumber: 38 },
          { chapterNumber: 9, verseNumber: 1 },
        ],
      },
      {
        bookCode: 'MRK',
        pericopeNumber: '6_1',
        pericopeTitle: null,
        verses: [
          { chapterNumber: 9, verseNumber: 2 },
          { chapterNumber: 10, verseNumber: 1 },
        ],
      },
      {
        bookCode: 'LUK',
        pericopeNumber: '5_1',
        pericopeTitle: null,
        verses: [{ chapterNumber: 1, verseNumber: 1 }],
      },
    ]);
  });

  it('filters and normalizes bookCode while preserving full cross-chapter groups', async () => {
    const res = await server.request('/pericope-sets/1?bookCode=%20mrk%20');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALL_GROUPS.slice(0, 2));
  });

  it.each(['/pericope-sets/3', '/pericope-sets/1?bookCode=JHN'])(
    'returns a cacheable empty representation for %s',
    async (path) => {
      const res = await server.request(path);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
      expect(res.headers.get('ETag')).toMatch(/^"[a-f0-9]{64}"$/);
      const cached = await server.request(path, {
        headers: { 'If-None-Match': res.headers.get('ETag')! },
      });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe('');
    }
  );

  it('hashes exact JSON bytes and stays stable after rows are reinserted in another order', async () => {
    const unicodeRows = SET_ONE_ROWS.map((row) => ({
      ...row,
      pericopeTitle: 'João — あ: "the Word" <&>\nA new line',
    }));
    await database.delete(pericope_verses).where(eq(pericope_verses.pericopeSetId, 1));
    await database.insert(pericope_verses).values(unicodeRows.toReversed());
    const first = await server.request('/pericope-sets/1');
    const body = await first.text();
    const etag = first.headers.get('ETag');
    expect(first.status).toBe(200);
    expect(etag).toBe(`"${createHash('sha256').update(body).digest('hex')}"`);
    expect(first.headers.get('Cache-Control')).toBe('private, no-cache');

    await database.delete(pericope_verses).where(eq(pericope_verses.pericopeSetId, 1));
    await database.insert(pericope_verses).values(unicodeRows);
    const second = await server.request('/pericope-sets/1');
    expect(await second.text()).toBe(body);
    expect(second.headers.get('ETag')).toBe(etag);
  });

  it.each(['exact', 'weak', 'list', 'wildcard'])(
    'returns an empty 304 for a matching %s If-None-Match',
    async (form) => {
      const first = await server.request('/pericope-sets/1');
      const etag = first.headers.get('ETag')!;
      const condition =
        form === 'weak'
          ? `W/${etag}`
          : form === 'list'
            ? `"old", W/${etag}, "another"`
            : form === 'wildcard'
              ? '*'
              : etag;
      const res = await server.request('/pericope-sets/1', {
        headers: { 'If-None-Match': condition },
      });
      expect(res.status).toBe(304);
      expect(await res.text()).toBe('');
      expect(res.headers.get('ETag')).toBe(etag);
      expect(res.headers.get('Cache-Control')).toBe('private, no-cache');
    }
  );

  it('returns the representation for a nonmatching condition', async () => {
    const res = await server.request('/pericope-sets/1', { headers: { 'If-None-Match': '"old"' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALL_GROUPS);
  });

  it('changes the validator after a title update, insertion, and deletion', async () => {
    let previous = (await server.request('/pericope-sets/1')).headers.get('ETag')!;
    const changes = [
      () =>
        database
          .update(pericope_verses)
          .set({ pericopeTitle: 'An updated title' })
          .where(
            and(
              eq(pericope_verses.pericopeSetId, 1),
              eq(pericope_verses.bookId, 41),
              eq(pericope_verses.pericopeNumber, '20')
            )
          ),
      () =>
        database.insert(pericope_verses).values({
          pericopeSetId: 1,
          bookId: 41,
          chapterNumber: 10,
          verseNumber: 1,
          pericopeNumber: '22',
        }),
      () =>
        database
          .delete(pericope_verses)
          .where(
            and(
              eq(pericope_verses.pericopeSetId, 1),
              eq(pericope_verses.bookId, 41),
              eq(pericope_verses.chapterNumber, 10)
            )
          ),
    ];
    for (const change of changes) {
      await change();
      const res = await server.request('/pericope-sets/1', {
        headers: { 'If-None-Match': previous },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('ETag')).not.toBe(previous);
      previous = res.headers.get('ETag')!;
    }
  });

  it('uses separate validators for filtered bodies and ignores changes outside the selected book', async () => {
    const all = await server.request('/pericope-sets/1');
    const filtered = await server.request('/pericope-sets/1?bookCode=MRK');
    const etag = filtered.headers.get('ETag')!;
    expect(etag).not.toBe(all.headers.get('ETag'));

    await database
      .update(pericope_verses)
      .set({ pericopeTitle: 'Changed Luke' })
      .where(eq(pericope_verses.bookId, 42));
    const res = await server.request('/pericope-sets/1?bookCode=MRK', {
      headers: { 'If-None-Match': etag },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    const full = await server.request('/pericope-sets/1', {
      headers: { 'If-None-Match': all.headers.get('ETag')! },
    });
    expect(full.status).toBe(200);
  });

  it('still returns 404 with a wildcard when the set or requested book does not exist', async () => {
    for (const [path, message] of [
      ['/pericope-sets/999', 'Pericope set not found'],
      ['/pericope-sets/1?bookCode=ZZZ', 'Book not found'],
    ]) {
      const res = await server.request(path, { headers: { 'If-None-Match': '*' } });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message });
      expect(res.headers.get('ETag')).toBeNull();
    }
  });

  it('returns 404 for a deleted set even when the client has its previous validator', async () => {
    await database.insert(schema.pericope_sets).values({ id: 4, name: 'Temporary set' });
    const first = await server.request('/pericope-sets/4');
    expect(first.status).toBe(200);
    await database.delete(schema.pericope_sets).where(eq(schema.pericope_sets.id, 4));
    const res = await server.request('/pericope-sets/4', {
      headers: { 'If-None-Match': first.headers.get('ETag')! },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: 'Pericope set not found' });
  });

  it.each(['invalid', '0', '-1', '1.5', '2147483648'])(
    'rejects invalid set id %s before conditional handling',
    async (id) => {
      const res = await server.request(`/pericope-sets/${id}`, {
        headers: { 'If-None-Match': '*' },
      });
      expect(res.status).toBe(400);
    }
  );

  it.each(['', '%20%20', 'INVALID_BOOK', 'AB', 'MRK!'])(
    'rejects malformed bookCode %s',
    async (bookCode) => {
      const res = await server.request(`/pericope-sets/1?bookCode=${bookCode}`, {
        headers: { 'If-None-Match': '*' },
      });
      expect(res.status).toBe(400);
    }
  );

  it('requires authentication even with a matching validator', async () => {
    const first = await server.request('/pericope-sets/1');
    vi.mocked(auth.api.getSession).mockResolvedValue(null);
    const res = await server.request('/pericope-sets/1', {
      headers: { 'If-None-Match': first.headers.get('ETag')! },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('ETag')).toBeNull();
  });

  it('rejects inactive accounts even with a wildcard', async () => {
    asAuthenticatedSetUser({ status: 'inactive' });
    const res = await server.request('/pericope-sets/1', { headers: { 'If-None-Match': '*' } });
    expect(res.status).toBe(403);
    expect(res.headers.get('ETag')).toBeNull();
  });

  it('exposes ETag to allowed browser origins', async () => {
    const res = await server.request('/pericope-sets/1', { headers: { Origin: env.FRONTEND_URL } });
    expect(res.status).toBe(200);
    expect(
      res.headers
        .get('Access-Control-Expose-Headers')
        ?.toLowerCase()
        .split(',')
        .map((header) => header.trim())
    ).toContain('etag');
  });

  it('returns a server error without a validator when the verse query fails', async () => {
    await client.exec('ALTER TABLE pericope_verses RENAME TO unavailable_pericope_verses');
    try {
      const res = await server.request('/pericope-sets/1', {
        headers: { 'If-None-Match': '*' },
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'An unexpected error occurred' });
      expect(res.headers.get('ETag')).toBeNull();
    } finally {
      await client.exec('ALTER TABLE unavailable_pericope_verses RENAME TO pericope_verses');
    }
  });

  it('generates the OpenAPI path, optional filter, conditional header and response contracts', () => {
    const document = server.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'Set sync test', version: '1' },
    });
    const operation = document.paths['/pericope-sets/{id}']?.get;
    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'id', in: 'path', required: true }),
        expect.objectContaining({ name: 'bookCode', in: 'query', required: false }),
        expect.objectContaining({ name: 'if-none-match', in: 'header', required: false }),
      ])
    );
    for (const status of ['200', '304']) {
      expect(operation?.responses[status]).toMatchObject({
        headers: { ETag: expect.any(Object), 'Cache-Control': expect.any(Object) },
      });
    }
    expect(operation?.responses['304']).not.toHaveProperty('content');
    for (const status of ['400', '401', '403', '404', '500']) {
      expect(operation?.responses[status]).toBeDefined();
    }
    expect(document.components?.schemas?.PericopeSetGroup).toMatchObject({
      allOf: [
        { $ref: '#/components/schemas/PericopeGroup' },
        { required: ['bookCode'], properties: { bookCode: { type: 'string' } } },
      ],
    });
    expect(document.components?.schemas?.PericopeGroup).toMatchObject({
      required: expect.arrayContaining(['pericopeNumber', 'pericopeTitle', 'verses']),
    });
  });
});
