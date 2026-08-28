import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireVerseAudioAccess } from './verse-audio-auth.middleware';
import * as verseAudioService from './verse-audio.service';
import {
  MAX_AUDIO_BYTES,
  resolveConflictBodySchema,
  VERSE_AUDIO_ACTIONS,
  VERSE_AUDIO_ID_SOURCES,
  verseAudioListResponseSchema,
  verseAudioResponseSchema,
} from './verse-audio.types';

// Covers both ways audio storage can be out: credentials unset, or the bucket
// unreachable at boot. Either way the answer is one clean 503 rather than a 500
// from whichever R2 call the request happened to reach.
const STORAGE_UNAVAILABLE_MESSAGE = 'Audio storage is unavailable';
const STORAGE_UNAVAILABLE_BODY = { message: STORAGE_UNAVAILABLE_MESSAGE } as const;

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
    createMessageObjectSchema(STORAGE_UNAVAILABLE_MESSAGE),
    'Audio storage is not configured, or its bucket was unreachable at startup'
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
            // Empty is normalised to absent before coercion: a client that always
            // appends the field to its FormData, empty when it has no local token,
            // is a legacy client, not a malformed request. Everything else present
            // must coerce to a positive integer — `z.coerce` alone would read '' as
            // 0 and reject it. This schema is enforced, not just documentation:
            // zod-openapi validates multipart bodies through the form validator.
            baseVersionToken: z
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
      'Unit metadata with versionToken, conflictStatus, takes, and playback URLs'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Missing/empty file, unsupported content type, or a malformed baseVersionToken'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'A concurrent write or cleanup invalidated the upload; reload and retry'
    ),
    413: jsonContent(
      createMessageObjectSchema('Payload too large'),
      'Audio file exceeds the 30 MB limit'
    ),
    ...commonErrorResponses,
  },
  summary: 'Upload an audio take for a verse',
  description:
    'Versioned upload: send baseVersionToken from the client’s last sync. Matching token replaces the active take; omitted token does the same for legacy clients; a present-but-stale token keeps both takes and marks conflict. Identical contentHash retries are idempotent (and promote a non-active matching take when the base is fresh). Once a unit is conflicted only the resolve endpoint clears it — an upload can become the active take but never settles the conflict on its own.',
});

server.openapi(uploadVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
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

  // The schema above has already rejected anything malformed. Re-derived here
  // rather than read from c.req.valid('form') because this handler works from its
  // own parseBody copy, and reading a fumbled token as absent would quietly
  // disable the conflict detection the token exists for.
  const baseRaw = body.baseVersionToken;
  let baseVersionToken: number | undefined;
  if (baseRaw !== undefined && baseRaw !== '') {
    const parsed = typeof baseRaw === 'string' ? Number(baseRaw) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      return c.json(
        { message: 'baseVersionToken must be a positive integer' },
        HttpStatusCodes.BAD_REQUEST
      );
    }
    baseVersionToken = parsed;
  }

  const data = Buffer.from(await file.arrayBuffer());

  const result = await verseAudioService.uploadRecording({
    projectUnitId,
    bibleTextId,
    uploadedBy: user.id,
    contentType: file.type,
    data,
    durationSeconds,
    baseVersionToken,
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
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.READ, VERSE_AUDIO_ID_SOURCES.PARAMS),
  ] as const,
  request: {
    params: verseAudioParamsSchema,
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioResponseSchema,
      'Unit metadata with conflict state, takes, and short-lived playback URLs'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Invalid parameters'
    ),
    ...commonErrorResponses,
  },
  summary: 'Get the audio recording for a verse',
  description:
    'Returns unit version/conflict state plus all takes, each with a read-only downloadUrl valid for 15 minutes. A conflicted unit keeps every take until it is resolved; on a settled clean unit, non-active takes are pruned once they fall outside the take retention window (AUDIO_TAKE_RETENTION_MS, 7 days by default), so takes[] collapses to the active take.',
});

server.openapi(getVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
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
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.READ, VERSE_AUDIO_ID_SOURCES.QUERY),
  ] as const,
  request: {
    query: z.object({
      projectUnitId: z.coerce.number().int().positive().openapi({ example: 12 }),
      bibleId: z.coerce.number().int().positive().openapi({ example: 1 }),
      bookId: z.coerce.number().int().positive().openapi({ example: 1 }),
      chapterNumber: z.coerce.number().int().positive().openapi({ example: 3 }),
    }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioListResponseSchema,
      'All recordings for the chapter plus a chapter-level hasConflict rollup'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Missing or invalid query parameters'
    ),
    ...commonErrorResponses,
  },
  summary: 'List audio recordings for a chapter',
  description:
    'One call per Bible chapter for mobile playback: every stored verse recording matching bibleId, bookId, and chapterNumber, verse-ordered, each with takes + downloadUrl, plus hasConflict when any matching unit is conflicted.',
});

server.openapi(listVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleId, bookId, chapterNumber } = c.req.valid('query');

  const result = await verseAudioService.listChapterRecordings(
    projectUnitId,
    bibleId,
    bookId,
    chapterNumber
  );
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── POST /verse-audio/{projectUnitId}/{bibleTextId}/resolve ──────────────────

const resolveVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'post',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}/resolve',
  middleware: [
    authenticateUser,
    requireVerseAudioAccess(VERSE_AUDIO_ACTIONS.EDIT, VERSE_AUDIO_ID_SOURCES.PARAMS),
  ] as const,
  request: {
    params: verseAudioParamsSchema,
    body: {
      content: {
        'application/json': {
          schema: resolveConflictBodySchema,
        },
      },
      required: true,
    },
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      verseAudioResponseSchema,
      'Unit after designating the active take (conflict cleared)'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      'Invalid parameters'
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      createMessageObjectSchema('Conflict'),
      'Verse audio changed concurrently; reload and retry'
    ),
    ...commonErrorResponses,
  },
  summary: 'Resolve a verse-audio conflict by selecting the active take',
  description:
    'Designates takeId as active via compare-and-swap on versionToken, clears conflictStatus, and advances the token. This is the only way a conflict is cleared; uploads never clear one. Non-selected takes are retained until the unit has been settled for the take retention window. Returns 409 if another writer advanced the token first.',
});

server.openapi(resolveVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleTextId } = c.req.valid('param');
  const { takeId } = c.req.valid('json');

  const result = await verseAudioService.resolveConflict({
    projectUnitId,
    bibleTextId,
    takeId,
  });
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json(result.data, HttpStatusCodes.OK);
});

// ─── DELETE /verse-audio/{projectUnitId}/{bibleTextId} ────────────────────────

const deleteVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'delete',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}',
  middleware: [
    authenticateUser,
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
  description: 'Removes the unit, all takes, and their blobs. Gated like editing the verse text.',
});

server.openapi(deleteVerseAudioRoute, async (c) => {
  if (!isAudioStorageAvailable()) {
    return c.json(STORAGE_UNAVAILABLE_BODY, HttpStatusCodes.SERVICE_UNAVAILABLE);
  }

  const { projectUnitId, bibleTextId } = c.req.valid('param');

  const result = await verseAudioService.deleteRecording(projectUnitId, bibleTextId);
  if (!result.ok) {
    return c.json({ message: result.error.message }, getHttpStatus(result.error) as never);
  }

  return c.json({ message: 'Verse audio recording deleted' }, HttpStatusCodes.OK);
});
