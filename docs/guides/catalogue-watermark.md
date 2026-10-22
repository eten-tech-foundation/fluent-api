# Catalogue watermark (#404)

Incremental `GET /languages`, `/books`, and `/bibles` use inclusive
`updatedAfter` cursors. Writers must participate in a **commit-ordered**
revision allocator so a client that advances its cursor while another
transaction is still open cannot permanently skip that write.

## Guarantee

- `next_catalogue_watermark()` updates the singleton `catalogue_watermark` row
  under a row lock held until commit/rollback.
- Defaults / `$onUpdate` on `languages`, `books`, and `bibles`, plus the
  provider-resource license trigger, call that function (never bare `now()` for
  catalogue stamps).
- Unchanged upsert arms keep the previous `updated_at` (no no-op stamp).

## Writer participation

| Writer                                            | How the watermark advances                                           |
| ------------------------------------------------- | -------------------------------------------------------------------- |
| Insert language / book / bible                    | Column `DEFAULT next_catalogue_watermark()`                          |
| ORM update of those tables                        | `$onUpdate` → `next_catalogue_watermark()`                           |
| DBL language/bible upsert conflict arm            | `THEN next_catalogue_watermark()` when a tracked column changes      |
| Provider-resource license/display/identity change | Trigger sets linked `bibles.updated_at = next_catalogue_watermark()` |

## Singleton lock trade-offs

`next_catalogue_watermark()` is a **global serializer** for catalogue writes: it
`UPDATE`s the single `catalogue_watermark` row and holds that lock until the
allocating transaction commits or rolls back. That is intentional — it is how
commit order becomes stamp order.

Lock order is not the same on every path:

- Direct catalogue update / insert: watermark row → target catalogue row
- License trigger: provider-resource row → watermark → linked `bibles` row

A transaction that holds the singleton and then waits on a row another writer
already locked can **deadlock**. Postgres aborts one side (no silent cursor
skip), but sync batch transactions should stay short and callers should treat
deadlock as retryable. Prefer allocating late in the transaction (after other
row locks are taken) when a writer touches both catalogue rows and unrelated
locked resources.

## Client cursor rules

See `src/lib/updated-after-query.ts`. Derive the next cursor from
`max(item.updatedAt)` on non-empty responses; keep the previous cursor on empty
lists; never use device wall-clock time.

## Tests

- PGlite: `catalogue-sync.watermark.integration.test.ts` (license trigger) and
  `catalogue-sync.watermark.allocator.integration.test.ts` (DEFAULT / `$onUpdate` /
  upsert conflict arms pinned past the wall clock).
- Multi-session PostgreSQL: `catalogue-sync.watermark.concurrency.integration.test.ts`
  (gated on `WATERMARK_TEST_DATABASE_URL` → disposable `fluent_watermark_test`).
  CI mirrors the `dlq-integration` disposable Postgres pattern.
