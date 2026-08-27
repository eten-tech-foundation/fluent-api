import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorCode } from '@/lib/types';

import { BOOK_DETAILS_PROJECTION, update } from './book-details.repository';
import { bookDetailsSchema } from './book-details.types';

// The sparse `set` object is the one thing in this domain a copy-paste slip could
// break invisibly: an omitted field still typechecks (every member is optional),
// the schema tests never reach the repository, and the route test mocks it away.
// So this file asserts on the object actually handed to drizzle's `.set()`.

vi.mock('@/db', () => ({
  db: { transaction: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

const ROW = {
  bookId: 1,
  bookCode: 'GEN',
  bookName: 'Genesis',
  runningHeader: null,
  bookTitle: null,
  tocLongName: null,
  tocShortName: 'Gênesis',
  tocAbbreviation: null,
};

/**
 * Chainable stub of the two statements `update()` runs inside its transaction.
 * `setCalls` collects every object passed to `.set()`. `onSet` lets a test make
 * the stub behave like the real driver, which throws on an empty set object.
 */
function stubTransaction(options: { onSet?: (set: unknown) => void } = {}) {
  const setCalls: Record<string, unknown>[] = [];

  const tx = {
    update: () => ({
      set: (set: Record<string, unknown>) => {
        setCalls.push(set);
        options.onSet?.(set);
        return {
          where: () => ({
            returning: async () => [{ bookId: ROW.bookId }],
          }),
        };
      },
    }),
    selectDistinct: () => ({
      from: () => ({
        innerJoin: () => ({
          where: async () => [ROW],
        }),
      }),
    }),
  };

  (db.transaction as any).mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));

  return setCalls;
}

describe('book-details repository update()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes exactly the fields the caller sent', async () => {
    const setCalls = stubTransaction();

    const result = await update(1, 1, {
      tocLongName: 'Gênesis',
      tocShortName: 'Gênesis',
      tocAbbreviation: 'Gn',
    });

    expect(result.ok).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toEqual({
      tocLongName: 'Gênesis',
      tocShortName: 'Gênesis',
      tocAbbreviation: 'Gn',
    });
  });

  it('leaves an unnamed field out of the set object entirely', async () => {
    const setCalls = stubTransaction();

    await update(1, 1, { tocShortName: 'Gênesis' });

    // Not just "bookTitle is undefined": an explicit `bookTitle: undefined` key
    // would still be a key, and `book_title` must not appear in the UPDATE at all,
    // which is what keeps a preserved legacy \mt preserved.
    expect(Object.keys(setCalls[0])).toEqual(['tocShortName']);
  });

  it('passes an explicit null through, so a field can be cleared', async () => {
    const setCalls = stubTransaction();

    await update(1, 1, { tocAbbreviation: null });

    expect(setCalls[0]).toEqual({ tocAbbreviation: null });
  });

  it('surfaces the driver error for an empty body rather than silently no-opping', async () => {
    // Unreachable through the route (the refine plus jsonContentRequired see to
    // that), but if it ever became reachable the real drizzle throws "No values to
    // set" — this pins that the repository reports it instead of swallowing it.
    const setCalls = stubTransaction({
      onSet: (set) => {
        if (Object.keys(set as object).length === 0) throw new Error('No values to set');
      },
    });

    const result = await update(1, 1, {});

    expect(setCalls[0]).toEqual({});
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error.code).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('book-details repository projection', () => {
  it('selects exactly the fields the response schema declares', () => {
    // The declared-versus-actual half of the contract whose other half lives in
    // book-details.types.test.ts. BOOK_DETAILS_PROJECTION is what the rows are
    // really built from; bookDetailsSchema is what the OpenAPI document promises
    // fluent-web. Nothing joins them: `ok(rows)` and `c.json(result.data)` both
    // pass variables rather than object literals, so TS's excess-property check
    // never applies, and `BookDetails` is inferred from the schema — narrowing the
    // schema narrows the very type the projection is measured against, so a
    // dropped field keeps compiling on both sides. Key-set equality is the join.
    //
    // Deliberately two-way. A field added to the projection and forgotten in the
    // schema would be served but undeclared, so the generated client never sees
    // it; a field added to the schema and forgotten here would be declared but
    // never sent, so the client reads undefined from a field it believes required.
    expect(Object.keys(BOOK_DETAILS_PROJECTION).sort()).toEqual(
      Object.keys(bookDetailsSchema.shape).sort()
    );
  });
});
