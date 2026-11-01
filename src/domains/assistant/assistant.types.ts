import { z } from '@hono/zod-openapi';

import type { BriefingEvent } from './assistant.client';

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

export type PublicBriefingEvent =
  | (Extract<BriefingEvent, { type: 'briefing_complete' }> & {
      operationVersion: string;
      cacheEpoch: string;
      outputLanguage: string;
      outputContractVersion: string;
      cacheHit: boolean;
    })
  | BriefingEvent
  | {
      type: 'briefing_started';
      attemptId: string;
      operationVersion: string;
      cacheEpoch: string;
      outputContractVersion: string;
      references: string[];
    };
