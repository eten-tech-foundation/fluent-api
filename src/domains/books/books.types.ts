import { z } from '@hono/zod-openapi';

import type { selectBooksSchema } from '@/db/schema';

export type Book = z.infer<typeof selectBooksSchema>;

export const bookResponseSchema = z.object({
  id: z.number().int(),
  code: z.string(),
  eng_display_name: z.string(),
  updatedAt: z.string().datetime().nullable().openapi({
    description:
      'Server watermark for this row. Clients must use max(updatedAt) across a successful non-empty list as the next updatedAfter cursor; empty lists must not advance the cursor.',
  }),
});

export type BookResponse = z.infer<typeof bookResponseSchema>;
