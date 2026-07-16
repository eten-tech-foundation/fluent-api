import { describe, expect, it, vi } from 'vitest';

// ─── Module mocks ─────────────────────────────────────────────────────────────
// Importing `@/app` wires up every route module + `configureOpenAPI(server)`,
// which registers the `/doc` endpoint. We only need the OpenAPI *document* to
// render, so stub out the side-effecting deps (DB, auth, logger) the same way
// the domain route tests do — none of them are touched by spec generation.

// Some modules build Drizzle queries at import time (e.g.
// projects.query-builder.ts calls `db.select(...).from(...)` at module scope).
// A plain `vi.fn()` returns `undefined`, so `.from` would throw during import
// and mask the actual thing under test. A self-returning chainable proxy lets
// those builders construct without touching a real DB; no query is executed by
// this test (it only renders the OpenAPI document).
const chainable: any = new Proxy(vi.fn(), {
  get: () => () => chainable,
  apply: () => chainable,
});

vi.mock('@/db', () => ({
  db: chainable,
}));

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

// ─── Regression: the OpenAPI spec must build ────────────────────────────────────
// `GET /doc` walks EVERY schema registered on the app to emit the OpenAPI JSON.
// If any registered schema is a node the generator can't render (e.g. a
// `.catch(...)`-wrapped schema, which zod-to-openapi has no handler for), the
// whole endpoint 500s — with nothing at the type/unit level to catch it, so it
// only surfaces at runtime (as it did: `/doc` returned 500 "Unknown zod object
// type"). This test renders the real, fully-assembled document and asserts it
// succeeds, so that class of break fails CI instead of production.

describe('gET /doc (OpenAPI document)', () => {
  it('renders the full OpenAPI spec without throwing (200, valid JSON)', async () => {
    const { default: app } = await import('@/app');

    const res = await app.request('/doc', { method: 'GET' });

    expect(res.status).toBe(200);

    const doc = await res.json();
    expect(doc.openapi).toBe('3.0.0');
    // A representative registered path proves the walk actually completed rather
    // than short-circuiting on an empty document.
    expect(doc.paths['/self/settings']).toBeDefined();
  });
});
