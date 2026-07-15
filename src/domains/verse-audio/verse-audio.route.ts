import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { isAudioStorageConfigured } from '@/lib/audio-storage';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireVerseAudioAccess } from './verse-audio-auth.middleware';
import * as verseAudioService from './verse-audio.service';
import {
  MAX_AUDIO_BYTES,
  storageUnavailableSchema,
  VERSE_AUDIO_ACTIONS,
  VERSE_AUDIO_ID_SOURCES,
  verseAudioListResponseSchema,
  verseAudioResponseSchema,
} from './verse-audio.types';

const STORAGE_UNAVAILABLE_BODY = {
  error: 'Verse audio is not available',
  details: 'Audio storage is not configured',
} as const;

const verseAudioParamsSchema = z.object({
  projectUnitId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectUnitId', in: 'path', required: true },
      description: 'Project unit ID',
      example: 12,
    }),
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

const commonErrorResponses = {
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
    storageUnavailableSchema,
    'Audio storage is not configured'
  ),
  [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
    createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
    'Internal server error'
  ),
} as const;

// ─── PUT /verse-audio/{projectUnitId}/{bibleTextId} ──────────────────────────

const uploadVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'put',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.EDIT, VERSE_AUDIO_ID_SOURCES.PARAMS),
    bodyLimit({
      maxSize: MAX_AUDIO_BYTES,
      onError: (c) => c.json({ message: 'Audio file exceeds the 30 MB limit' }, 413),
    }),
  ] as const,
  request: {
    params: verseAudioParamsSchema,
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
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioResponseSchema,
      'The stored recording metadata with a playback URL'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Missing/empty file or unsupported content type'
    ),
    413: jsonContent(
      createMessageObjectSchema('Payload too large'),
      'Audio file exceeds the 30 MB limit'
    ),
    ...commonErrorResponses,
  },
  summary: 'Upload or replace the audio recording for a verse',
  description:
    'One recording per verse per project unit: uploading again replaces the previous audio in place. Gated like editing the verse text (assigned translator / stage rules).',
});

server.openapi(uploadVerseAudioRoute, async (c) => {
  if (!isAudioStorageConfigured()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleTextId } = c.req.valid('param');
  const user = c.get('user')!;

  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ message: 'Missing audio file' }, HttpStatusCodes.BAD_REQUEST);
  }

  const durationRaw = Number(body.durationSeconds);
  const durationSeconds = Number.isFinite(durationRaw) && durationRaw > 0 ? durationRaw : undefined;

  const data = Buffer.from(await file.arrayBuffer());

  const result = await verseAudioService.uploadRecording({
    projectUnitId,
    bibleTextId,
    uploadedBy: user.id,
    contentType: file.type,
    data,
    durationSeconds,
  });

  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /verse-audio/{projectUnitId}/{bibleTextId} ───────────────────────────

const getVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'get',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.READ, VERSE_AUDIO_ID_SOURCES.PARAMS),
  ] as const,
  request: {
    params: verseAudioParamsSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioResponseSchema,
      'Recording metadata with a short-lived playback URL'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Invalid parameters'
    ),
    ...commonErrorResponses,
  },
  summary: 'Get the audio recording for a verse',
  description:
    'Returns metadata plus a read-only SAS downloadUrl valid for 15 minutes; players stream directly from blob storage.',
});

server.openapi(getVerseAudioRoute, async (c) => {
  if (!isAudioStorageConfigured()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleTextId } = c.req.valid('param');

  const result = await verseAudioService.getRecording(projectUnitId, bibleTextId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── GET /verse-audio (chapter listing) ───────────────────────────────────────

const listVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'get',
  path: '/verse-audio',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.PROJECT_VIEW),
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.READ, VERSE_AUDIO_ID_SOURCES.QUERY),
  ] as const,
  request: {
    query: z.object({
      projectUnitId: z.coerce.number().int().positive().openapi({ example: 12 }),
      bookId: z.coerce.number().int().positive().openapi({ example: 1 }),
      chapterNumber: z.coerce.number().int().positive().openapi({ example: 3 }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioListResponseSchema,
      'All recordings for the chapter, ordered by verse number'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Missing or invalid query parameters'
    ),
    ...commonErrorResponses,
  },
  summary: 'List audio recordings for a chapter',
  description:
    'One call per chapter for mobile playback: every stored verse recording in the chapter, verse-ordered, each with a 15-minute downloadUrl.',
});

server.openapi(listVerseAudioRoute, async (c) => {
  if (!isAudioStorageConfigured()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bookId, chapterNumber } = c.req.valid('query');

  const result = await verseAudioService.listChapterRecordings(
    projectUnitId,
    bookId,
    chapterNumber
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json({ items: result.data }, HttpStatusCodes.OK);
});

// ─── DELETE /verse-audio/{projectUnitId}/{bibleTextId} ────────────────────────

const deleteVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'delete',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.CONTENT_UPDATE),
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.EDIT, VERSE_AUDIO_ID_SOURCES.PARAMS),
  ] as const,
  request: {
    params: verseAudioParamsSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      createMessageObjectSchema('Verse audio recording deleted'),
      'Recording deleted'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Invalid parameters or verse reference'
    ),
    ...commonErrorResponses,
  },
  summary: 'Delete the audio recording for a verse',
  description: 'Removes both the blob and the metadata row. Gated like editing the verse text.',
});

server.openapi(deleteVerseAudioRoute, async (c) => {
  if (!isAudioStorageConfigured()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleTextId } = c.req.valid('param');

  const result = await verseAudioService.deleteRecording(projectUnitId, bibleTextId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json({ message: 'Verse audio recording deleted' }, HttpStatusCodes.OK);
});
