import { z } from '@hono/zod-openapi';

import type { selectLanguagesSchema } from '@/db/schema';

export type Language = z.infer<typeof selectLanguagesSchema>;

export const languageResponseSchema = z.object({
  id: z.number().int(),
  langName: z.string(),
  langNameLocalized: z.string().nullable(),
  langCodeIso6393: z.string().nullable(),
  scriptDirection: z.enum(['ltr', 'rtl']).nullable(),
  updatedAt: z.string().datetime().nullable().openapi({
    description:
      'Server watermark for this row. Clients must use max(updatedAt) across a successful non-empty list as the next updatedAfter cursor; empty lists must not advance the cursor.',
  }),
});

export type LanguageResponse = z.infer<typeof languageResponseSchema>;
