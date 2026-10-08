import { z } from '@hono/zod-openapi';

/**
 * Rejects ISO date-times that Date would silently roll over (e.g. 2025-02-30).
 * Only applies the UTC component check for `Z` / `z` suffixes; offset forms are
 * already constrained by `z.string().datetime({ offset: true })`.
 */
function isValidCalendarDateTime(value: string): boolean {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  if (!/[Zz]$/.test(value)) return true;

  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

/**
 * Optional ISO-8601 `updatedAfter` query param used by incremental catalogue sync.
 * Empty / unzoned / invalid calendars fail Zod validation → HTTP 400 via @hono/zod-validator.
 */
export const updatedAfterQuerySchema = z
  .string()
  .datetime({
    offset: true,
    message: 'updatedAfter must be an ISO-8601 date-time with an explicit time zone',
  })
  .refine(isValidCalendarDateTime, {
    message: 'updatedAfter must be a valid calendar date-time',
  })
  .transform((value) => new Date(value))
  .optional()
  .openapi({
    param: { name: 'updatedAfter', in: 'query', required: false },
    description:
      'Return only rows updated at or after this ISO-8601 date-time (must include an explicit time zone)',
    example: '2025-01-01T00:00:00.000Z',
  });

export const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
  }),
});
