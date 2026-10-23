import type { Context } from 'hono';

import { z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import type { AppError } from '@/lib/types';

import { ErrorCode, getHttpStatus } from '@/lib/types';

import * as verseAudioService from './verse-audio.service';

const STORAGE_UNAVAILABLE_MESSAGE = 'Audio storage is unavailable';
export const STORAGE_UNAVAILABLE_BODY = { message: STORAGE_UNAVAILABLE_MESSAGE } as const;

export const projectUnitIdParamSchema = z.object({
  projectUnitId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectUnitId', in: 'path', required: true },
      description: 'Project unit ID',
      example: 12,
    }),
});

export const verseAudioParamsSchema = projectUnitIdParamSchema.extend({
  bibleTextId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'bibleTextId', in: 'path', required: true },
      description: 'bible_texts.id of the verse',
      example: 3401,
    }),
});

export const baseVersionTokenFormField = z
  .preprocess(
    (value) => (value === '' ? undefined : value),
    z.coerce.number().int().positive().optional()
  )
  .openapi({
    type: 'integer',
    minimum: 1,
    description:
      'Last-known unit versionToken (starts at 1). Matching token updates the active take; omitted or empty replaces the active take on behalf of clients too old to send one; a present-but-stale token keeps both takes and marks conflict. Present but not a positive integer is a 400. No upload clears an existing conflict — use the resolve endpoint.',
    example: 1,
  });

export const commonErrorResponses = {
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
    createMessageObjectSchema('Unauthorized'),
    'Authentication required'
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(createMessageObjectSchema('Forbidden'), 'Access denied'),
  [HttpStatusCodes.NOT_FOUND]: jsonContent(
    createMessageObjectSchema(HttpStatusPhrases.NOT_FOUND),
    'Recording, verse, or assignment not found'
  ),
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: jsonContent(
    createMessageObjectSchema(STORAGE_UNAVAILABLE_MESSAGE),
    'Audio storage is not configured, or its bucket was unreachable at startup'
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
    'Internal server error'
  ),
} as const;

export async function respondVerseAudioError(
  c: Context,
  projectUnitId: number,
  bibleTextId: number,
  error: AppError
) {
  const status = getHttpStatus(error);
  const body: { message: string; currentVersionToken?: number } = {
    message: error.message,
  };

  if (error.code === ErrorCode.VERSE_AUDIO_VERSION_CONFLICT) {
    const current = await verseAudioService.getCurrentVersionToken(projectUnitId, bibleTextId);
    if (current.ok) {
      body.currentVersionToken = current.data;
    }
  }

  return c.json(body, status as never);
}

export function parseOptionalBaseVersionToken(
  baseRaw: unknown
): { ok: true; value: number | undefined } | { ok: false } {
  if (baseRaw === undefined || baseRaw === '') {
    return { ok: true, value: undefined };
  }
  const parsed = typeof baseRaw === 'string' ? Number(baseRaw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false };
  }
  return { ok: true, value: parsed };
}

export function parsePositiveIntField(raw: unknown): number | null {
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }
  return parsed;
}
