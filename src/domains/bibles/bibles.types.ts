import { z } from '@hono/zod-openapi';

import type { insertBiblesSchema, patchBiblesSchema, selectBiblesSchema } from '@/db/schema';

// ─── DB-derived types ─────────────────────────────────────────────

export type Bible = z.infer<typeof selectBiblesSchema>;
export type CreateBible = z.infer<typeof insertBiblesSchema>;
export type UpdateBible = z.infer<typeof patchBiblesSchema>;

export const bibleResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  abbreviation: z.string(),
  languageId: z.number().int(),
  hasAudio: z.boolean(),
});

export type BibleResponse = z.infer<typeof bibleResponseSchema>;
