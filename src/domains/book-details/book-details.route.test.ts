import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { server } from '@/server/server';

import type { BookDetails, UpdateBookDetailsInput } from './book-details.types';

import * as repository from './book-details.repository';

import '@/domains/book-details/book-details.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  // authenticate reads the session's activeOrgId through this chain; an empty
  // result stands for "no active org picked", which these routes never consult.
  const mockQueryBuilder = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    db: {
      select: vi.fn(() => mockQueryBuilder),
      update: vi.fn(() => mockQueryBuilder),
      transaction: vi.fn(),
    },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

// The record-level check needs a project, a project unit and a membership lookup,
// i.e. a database. Stubbed to a pass-through, which means these tests say nothing
// about project scoping — that check returns 404 (deliberately, so project units
// cannot be enumerated) and is covered by its own middleware, not here.
vi.mock('./book-details-auth.middleware', () => ({
  requireBookDetailsAccess: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

const stored: BookDetails = {
  bookId: 1,
  bookCode: 'GEN',
  bookName: 'Genesis',
  runningHeader: null,
  bookTitle: null,
  tocLongName: null,
  tocShortName: null,
  tocAbbreviation: null,
};

vi.mock('./book-details.repository', () => ({
  list: vi.fn(async () => ({ ok: true, data: [] })),
  update: vi.fn(async (_projectUnitId: number, _bookId: number, input: UpdateBookDetailsInput) => ({
    ok: true,
    data: { ...stored, ...input },
  })),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRANSLATOR = {
  id: 1,
  email: 'translator@example.com',
  status: 'verified' as const,
};

function authenticateAs(user: typeof TRANSLATOR, granted = true) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: user.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: user });
  // The caller's role flattened to a project-pinned grant, translator-shaped.
  // `granted` toggles whether that grant carries the permission the PATCH gates on.
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: [
      {
        orgId: 1,
        projectId: 1,
        permissions: new Set(granted ? [PERMISSIONS.CONTENT_UPDATE] : [PERMISSIONS.PROJECT_VIEW]),
      },
    ],
  });
}

function patchBookDetails(body: unknown, headers: Record<string, string> = {}) {
  return server.request('/project-units/1/book-details/1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('pATCH /project-units/{projectUnitId}/book-details/{bookId}', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a body naming only a TOC field', async () => {
    authenticateAs(TRANSLATOR);

    const res = await patchBookDetails({ tocShortName: 'Gênesis' });

    expect(res.status).toBe(200);
    // The echoed body is the repository mock's return value, not proof that the
    // response schema is right — the schema half is pinned in the types test.
    expect((await res.json()).tocShortName).toBe('Gênesis');
  });

  it('rejects a request the validator would otherwise be skipped for', async () => {
    authenticateAs(TRANSLATOR);

    // Without `required: true` on the body, @hono/zod-openapi replaces the
    // validator with a middleware that only runs when a JSON Content-Type is
    // present, and otherwise hands the handler `{}` — which reaches drizzle as an
    // empty set object and 500s. Both bypass halves are covered here.
    const noContentType = await server.request('/project-units/1/book-details/1', {
      method: 'PATCH',
    });
    expect(noContentType.status).toBe(400);

    const textPlain = await server.request('/project-units/1/book-details/1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ tocShortName: 'Gênesis' }),
    });
    expect(textPlain.status).toBe(400);

    // And an empty JSON object is rejected by the refine, on the wire.
    const emptyBody = await patchBookDetails({});
    expect(emptyBody.status).toBe(400);
  });

  it('rejects marker syntax and pipes with a 400', async () => {
    authenticateAs(TRANSLATOR);

    // 400, not the declared-but-unreachable 422: this app wires no defaultHook,
    // so @hono/zod-validator answers rejections itself.
    expect((await patchBookDetails({ tocLongName: 'Genesis\\mt' })).status).toBe(400);
    expect((await patchBookDetails({ tocAbbreviation: 'Gn|Ge' })).status).toBe(400);
  });

  it('rejects a non-integer bookId at the validator, before it can reach the database', async () => {
    authenticateAs(TRANSLATOR);

    // `z.coerce.number()` alone accepts `1.5`, and nothing downstream re-checks
    // bookId: `requireBookDetailsAccess` only validates projectUnitId. The value
    // would reach the repository and be bound to an `integer` column, where
    // Postgres rejects the parameter with SQLSTATE 22P02 rather than matching no
    // row — verified against a real Postgres. The repository catches that and
    // returns INTERNAL_ERROR, so the caller got a 500 for a plainly bad request.
    const fractional = await server.request('/project-units/1/book-details/1.5', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tocShortName: 'Gênesis' }),
    });
    expect(fractional.status).toBe(400);

    // The point of the constraint is that the repository is never reached at all,
    // which is what keeps this a 400 rather than the 500 the database would force.
    expect(repository.update).not.toHaveBeenCalled();

    // A negative bookId matched no row and so already answered 404 rather than
    // 500. It is still not a valid ID, and now the validator says so.
    const negative = await server.request('/project-units/1/book-details/-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tocShortName: 'Gênesis' }),
    });
    expect(negative.status).toBe(400);
    expect(repository.update).not.toHaveBeenCalled();

    // Control: a well-formed ID still gets through to the repository.
    expect((await patchBookDetails({ tocShortName: 'Gênesis' })).status).toBe(200);
    expect(repository.update).toHaveBeenCalledTimes(1);
  });

  it('enforces authentication and the intended permission', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);
    const anonymous = await patchBookDetails({ tocShortName: 'Gênesis' });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ message: 'User not authenticated' });

    authenticateAs(TRANSLATOR, false);
    const withoutPermission = await patchBookDetails({ tocShortName: 'Gênesis' });
    expect(withoutPermission.status).toBe(403);
    expect(await withoutPermission.json()).toEqual({ message: 'Insufficient permissions' });

    // The intended rule, stated rather than merely observed: content:update is
    // what this endpoint gates on today, so a translator assigned to the project
    // may edit these fields. Tightening it to project:update should read as a
    // deliberate contract change here, not as a mystery regression.
    authenticateAs(TRANSLATOR, true);
    const withPermission = await patchBookDetails({ tocShortName: 'Gênesis' });
    expect(withPermission.status).toBe(200);
  });
});
