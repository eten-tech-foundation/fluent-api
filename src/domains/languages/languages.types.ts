import { z } from '@hono/zod-openapi';

import type { selectLanguagesSchema } from '@/db/schema';

export type Language = z.infer<typeof selectLanguagesSchema>;

export const languageResponseSchema = z.object({
  id: z.number().int(),
  langName: z.string(),
  langNameLocalized: z.string().nullable(),
  langCodeIso6393: z.string().nullable(),
  scriptDirection: z.enum(['ltr', 'rtl']).nullable(),
});

export type LanguageResponse = z.infer<typeof languageResponseSchema>;
