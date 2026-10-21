import { z } from '@hono/zod-openapi';

/**
 * Optional ISO-8601 `updatedAfter` query param used by incremental catalogue sync.
 * Empty / unzoned / invalid calendars fail Zod validation → HTTP 400 via @hono/zod-validator.
 * `z.string().datetime({ offset: true })` already rejects impossible calendar dates
 * (e.g. 2025-02-30) in both `Z` and offset forms on zod 3.25.x.
 *
 * Cursor contract (languages / books / bibles list arrays):
 * - Filter is inclusive: `updatedAt >= updatedAfter`.
 * - Each list item exposes server `updatedAt` (ISO-8601). Clients must persist the next
 *   cursor from those values (typically `max(updatedAt)` across returned items for that
 *   catalogue), never from the device wall clock.
 * - On `200` + `[]`, keep the previous cursor unchanged (do not advance).
 * - Equal timestamps are re-fetched on the next call (`gte`); clients must upsert idempotently.
 * - Concurrent writes during a fetch may require a later sync; advancing past server
 *   timestamps with device time can skip rows permanently.
 * - Catalogue writers (languages / books / bibles + provider-resource license
 *   trigger) stamp `updatedAt` via `next_catalogue_watermark()` (#404). That
 *   singleton row-lock orders commits so a cursor issued mid-flight cannot
 *   permanently skip an earlier-started, later-committed write.
 */
export const updatedAfterQuerySchema = z
  .string()
  .datetime({
    offset: true,
    message: 'updatedAfter must be an ISO-8601 date-time with an explicit time zone',
  })
  .transform((value) => new Date(value))
  .pipe(z.date())
  .optional()
  .openapi({
    param: { name: 'updatedAfter', in: 'query', required: false },
    description:
      'Inclusive lower bound (`updatedAt >= updatedAfter`). ISO-8601 with explicit time zone. Derive the next cursor from max(item.updatedAt) in the response; on empty arrays keep the previous cursor. Do not use device wall-clock time.',
    example: '2025-01-01T00:00:00.000Z',
  });

/**
 * Shared OpenAPI body for Zod validation failures on the three catalogue list
 * routes. Broader convergence onto stoker's `createErrorSchema` is out of scope
 * for this PR (other domains still keep local copies).
 */
export const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
  }),
});
