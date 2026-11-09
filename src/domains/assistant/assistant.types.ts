import { z } from '@hono/zod-openapi';

import type { Result } from '@/lib/types';

import type { BriefingEvent } from './assistant.client';

export const assistantActionsSchema = z
  .array(
    z
      .object({
        type: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        purpose: z.string().min(1).max(1024),
        template: z.string().min(1).max(4096),
      })
      .strict()
  )
  .max(32)
  .refine(
    (actions) => new TextEncoder().encode(JSON.stringify(actions)).byteLength <= 32768,
    'Action catalog exceeds byte budget'
  )
  .refine(
    (actions) => new Set(actions.map((action) => action.type)).size === actions.length,
    'Duplicate action type'
  );
export type AssistantActions = z.infer<typeof assistantActionsSchema>;

export const assistantBriefingRequestSchema = z.object({
  bookCode: z.string().min(3).max(50),
  chapter: z.number().int().positive(),
  activeVerse: z.number().int().positive(),
  outputLanguage: z.string().min(1).max(20),
  grounding: z.enum(['configured', 'output_language', 'english']).optional(),
  ignore_cache: z.boolean().optional(),
  actions: assistantActionsSchema.optional(),
});

export const assistantErrorSchema = z.object({
  code: z.enum([
    'invalid_request',
    'invalid_configuration',
    'unsupported_language',
    'context_too_large',
    'rate_limited',
    'generation_busy',
    'timed_out',
    'temporarily_unavailable',
    'malformed_upstream_response',
  ]),
  retryable: z.boolean(),
  retryAfter: z.number().int().min(0).max(86_400).optional(),
});
export type AssistantError = z.infer<typeof assistantErrorSchema>;
export type AssistantServiceError = Omit<AssistantError, 'code'> & {
  code: AssistantError['code'] | 'context_changed';
};
export type BriefingServiceErrorCode = AssistantError['code'];

export function assistantFailure<C extends AssistantServiceError['code']>(
  code: C,
  retryable = code === 'temporarily_unavailable'
): Extract<Result<never, { code: C; retryable: boolean }>, { ok: false }> {
  return { ok: false, error: { code, retryable } };
}

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
