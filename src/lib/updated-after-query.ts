import { z } from '@hono/zod-openapi';

/**
 * Optional ISO-8601 `updatedAfter` query param used by incremental catalogue sync.
 * Invalid timestamps fail Zod validation and surface as HTTP 400 via @hono/zod-validator.
 */
export const updatedAfterQuerySchema = z
  .string()
  .optional()
  .transform((val) => (val ? new Date(val) : undefined))
  .pipe(z.date().optional())
  .openapi({
    param: { name: 'updatedAfter', in: 'query', required: false },
    description: 'Return only rows updated after this ISO timestamp',
    example: '2025-01-01T00:00:00.000Z',
  });

export const validationErrorSchema = z.object({
  success: z.boolean(),
  error: z.object({
    issues: z.array(z.object({ code: z.string(), path: z.array(z.string()), message: z.string() })),
    name: z.string(),
  }),
});
