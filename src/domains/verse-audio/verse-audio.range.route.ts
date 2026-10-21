import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireEditVerseAudioAccess } from './verse-audio-auth.middleware';
import * as rangeAudioService from './verse-audio.range.service';
import {
  baseVersionTokenFormField,
  commonErrorResponses,
  parseOptionalBaseVersionToken,
  parsePositiveIntField,
  projectUnitIdParamSchema,
  respondVerseAudioError,
  STORAGE_UNAVAILABLE_BODY,
} from './verse-audio.route-shared';
import {
  MAX_AUDIO_BYTES,
  VERSE_AUDIO_ID_SOURCES,
  verseAudioResponseSchema,
  verseAudioVersionConflictSchema,
} from './verse-audio.types';

// Registered before /{projectUnitId}/{bibleTextId} so "range" is not captured
// as a bibleTextId path segment (import this module before verse-audio.route).

// ─── PUT /verse-audio/{projectUnitId}/range ──────────────────────────────────
// Registered before /{projectUnitId}/{bibleTextId} so "range" is not captured
// as a bibleTextId path segment.

const uploadRangeVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'put',
  path: '/verse-audio/{projectUnitId}/range',
  middleware: [
    authenticateUser,
    // bodyLimit must run before FORM auth parseBody — otherwise the stream is locked.
    bodyLimit({
      maxSize: MAX_AUDIO_BYTES,
      onError: (c) =>
        c.json({ message: 'Audio file exceeds the 30 MB limit' }, HttpStatusCodes.REQUEST_TOO_LONG),
    }),
    requireEditVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.FORM),
  ] as const,
  request: {
    params: projectUnitIdParamSchema,
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any().openapi({
              type: 'string',
              format: 'binary',
              description: 'Audio file (mp3, m4a/aac/mp4, webm, wav, or ogg)',
            }),
            durationSeconds: z.coerce.number().positive().optional().openapi({
              description: 'Client-measured duration in seconds',
              example: 12.5,
            }),
            baseVersionToken: baseVersionTokenFormField,
            granularity: z.literal('pericope').openapi({
              description: 'Must be pericope for this route',
              example: 'pericope',
            }),
            bibleTextId: z.coerce.number().int().positive().openapi({
              description:
                'Anchor bible_texts.id — must match startChapter/startVerse of the range',
              example: 3401,
            }),
            startChapter: z.coerce.number().int().positive().openapi({ example: 1 }),
            startVerse: z.coerce.number().int().positive().openapi({ example: 1 }),
            endChapter: z.coerce.number().int().positive().openapi({ example: 1 }),
            endVerse: z.coerce.number().int().positive().openapi({ example: 5 }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioResponseSchema,
      'Unit metadata with range fields, versionToken, conflictStatus, takes, and playback URLs'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Missing/empty file, malformed token/range fields, invalid anchor, or unsupported content type'
    ),
    [HttpStatusCodes.UNPROCESSABLE_ENTITY]: jsonContent(
      createMessageObjectSchema('Validation failed'),
      'Empty, reversed, or malformed pericope range'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      verseAudioVersionConflictSchema,
      'A concurrent write or cleanup invalidated the upload; refresh currentVersionToken and retry'
    ),
    [HttpStatusCodes.REQUEST_TOO_LONG]: jsonContent(
      createMessageObjectSchema('Payload too large'),
      'Audio file exceeds the 30 MB limit'
    ),
    ...commonErrorResponses,
  },
  summary: 'Upload a pericope / verse-range audio take',
  description:
    'Accepts granularity=pericope with start/end chapter and verse. bibleTextId is the anchor (first verse) and must match startChapter/startVerse on bible_texts. Version/CAS semantics match single-verse upload. After a successful upload, other same-book recordings whose active coverage intersects this range are marked conflict without bumping their versionToken.',
});

server.openapi(uploadRangeVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId } = c.req.valid('param');
  const user = c.get('user')!;

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ message: 'Missing audio file' }, HttpStatusCodes.BAD_REQUEST);
  }

  if (body.granularity !== 'pericope') {
    return c.json({ message: 'granularity must be pericope' }, HttpStatusCodes.BAD_REQUEST);
  }

  const bibleTextId = parsePositiveIntField(body.bibleTextId);
  if (bibleTextId === null) {
    return c.json(
      { message: 'bibleTextId must be a positive integer' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  const startChapter = parsePositiveIntField(body.startChapter);
  const startVerse = parsePositiveIntField(body.startVerse);
  const endChapter = parsePositiveIntField(body.endChapter);
  const endVerse = parsePositiveIntField(body.endVerse);
  if (startChapter === null || startVerse === null || endChapter === null || endVerse === null) {
    return c.json(
      { message: 'startChapter, startVerse, endChapter, and endVerse must be positive integers' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  const durationRaw = Number(body.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined;

  const baseToken = parseOptionalBaseVersionToken(body.baseVersionToken);
  if (!baseToken.ok) {
    return c.json(
      { message: 'baseVersionToken must be a positive integer' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  const data = Buffer.from(await file.arrayBuffer());

  const result = await rangeAudioService.uploadRangeRecording({
    projectUnitId,
    bibleTextId,
    uploadedBy: user.id,
    contentType: file.type,
    data,
    durationSeconds,
    baseVersionToken: baseToken.value,
    granularity: 'pericope',
    startChapter,
    startVerse,
    endChapter,
    endVerse,
  });

  if (!result.ok) {
    return respondVerseAudioError(c, projectUnitId, bibleTextId, result.error);
  }

  return c.json(result.data, HttpStatusCodes.OK);
});
