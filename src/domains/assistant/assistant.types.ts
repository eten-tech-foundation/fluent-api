import { z } from '@hono/zod-openapi';

export const assistantBriefingRequestSchema = z.object({
  bookCode: z.string().min(3).max(50),
  chapter: z.number().int().positive(),
  activeVerse: z.number().int().positive(),
  outputLanguage: z.string().min(1).max(20),
  grounding: z.enum(['configured', 'output_language', 'english']).optional(),
  ignore_cache: z.boolean().optional(),
});

export type BriefingServiceErrorCode =
  'temporarily_unavailable' | 'invalid_request' | 'unsupported_language' | 'context_too_large';
