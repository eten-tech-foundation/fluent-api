import { createRoute, z } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { isAudioStorageAvailable } from '@/lib/audio-storage';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import {
  requireEditVerseAudioAccess,
  requireReadVerseAudioAccess,
  requireResolveVerseAudioConflictAccess,
} from './verse-audio-auth.middleware';
import {
  baseVersionTokenFormField,
  commonErrorResponses,
  parseOptionalBaseVersionToken,
  respondVerseAudioError,
  STORAGE_UNAVAILABLE_BODY,
  verseAudioParamsSchema,
} from './verse-audio.route-shared';
import * as verseAudioService from './verse-audio.service';
import {
  MAX_AUDIO_BYTES,
  resolveConflictBodySchema,
  VERSE_AUDIO_ID_SOURCES,
  verseAudioListResponseSchema,
  verseAudioResponseSchema,
  verseAudioVersionConflictSchema,
} from './verse-audio.types';

// ─── PUT /verse-audio/{projectUnitId}/{bibleTextId} ──────────────────────────

const uploadVerseAudioRoute = createRoute({
  tags: ['Verse Audio'],
  method: 'put',
  path: '/verse-audio/{projectUnitId}/{bibleTextId}',
  middleware: [
    authenticateUser,
    requireEditVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.PARAMS),
    bodyLimit({
      maxSize: MAX_AUDIO_BYTES,
      onError: (c) =>
        c.json({ message: 'Audio file exceeds the 30 MB limit' }, HttpStatusCodes.REQUEST_TOO_LONG),
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
            baseVersionToken: baseVersionTokenFormField,
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
      verseAudioVersionConflictSchema,
      'A concurrent write or cleanup invalidated the upload; refresh currentVersionToken and retry'
    ),
    [HttpStatusCodes.REQUEST_TOO_LONG]: jsonContent(
      createMessageObjectSchema('Payload too large'),
      'Audio file exceeds the 30 MB limit'
    ),
    ...commonErrorResponses,
  },
  summary: 'Upload an audio take for a verse',
  description:
    'Versioned upload: send baseVersionToken from the client’s last sync. Matching token replaces the active take; omitted token does the same for legacy clients (deprecated escape hatch — logged as verse_audio_upload_legacy_no_token until mobile builds all send the field); a present-but-stale token keeps both takes and marks conflict. Identical contentHash retries are idempotent (and promote a non-active matching take when the base is fresh). Once a unit is conflicted only the resolve endpoint clears it — an upload can become the active take but never settles the conflict on its own.',
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
  const baseToken = parseOptionalBaseVersionToken(body.baseVersionToken);
  if (!baseToken.ok) {
    return c.json(
      { message: 'baseVersionToken must be a positive integer' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  const data = Buffer.from(await file.arrayBuffer());

  const result = await verseAudioService.uploadRecording({
    projectUnitId,
    bibleTextId,
    uploadedBy: user.id,
    contentType: file.type,
    data,
    durationSeconds,
    baseVersionToken: baseToken.value,
  });

  if (!result.ok) {
    return respondVerseAudioError(c, projectUnitId, bibleTextId, result.error);
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
    requireReadVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.PARAMS),
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
    'Selected-canonical unit hydration: stable projectUnitId + bibleTextId (anchor) identity, explicit granularity and full coverage anchors (startChapter/startVerse/endChapter/endVerse; verse units hydrate inclusive bible_texts anchors on read), conflictStatus preserved, and takes[] each with contentHash + short-lived downloadUrl (~15 minutes). Top-level downloadUrl is set only when activeTakeId exactly matches a take — null when active is null or unmatched (no last-take invent fallback). A conflicted unit keeps every take until it is resolved; on a settled clean unit, non-active takes are pruned once they fall outside the take retention window (AUDIO_TAKE_RETENTION_MS, 7 days by default), so takes[] collapses to the active take. Matching-base/legacy upload may advance activeTakeId while conflictStatus remains conflict; POST .../resolve is what marks resolved. No invented playback policy.',
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
    requireReadVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.QUERY),
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
    'Selected-canonical chapter listing for offline draft hydration: every stored recording whose bible_texts anchor matches bibleId, bookId, and chapterNumber, verse-ordered. Each item matches unit GET for the same identity (granularity, full coverage including cross-chapter pericope end bounds, activeTakeId, conflictStatus, takes). Top-level downloadUrl follows exact activeTakeId match only (null when unavailable). hasConflict is true when any listed unit has conflictStatus=conflict. List membership is by anchor chapter — a cross-chapter pericope appears on its start/anchor chapter with endChapter/endVerse exposing the full span.',
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
    requireResolveVerseAudioConflictAccess(VERSE_AUDIO_ID_SOURCES.PARAMS),
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
      "Unit after designating the active take (conflictStatus set to 'resolved')"
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad request'),
      "Invalid parameters, or the unit is not currently in conflict (conflictStatus must be 'conflict')"
    ),
    [HttpStatusCodes.CONFLICT]: jsonContent(
      verseAudioVersionConflictSchema,
      'Verse audio changed concurrently; refresh currentVersionToken and retry'
    ),
    ...commonErrorResponses,
  },
  summary: 'Resolve a verse-audio conflict by selecting the active take',
  description:
    "Designates takeId as active via compare-and-swap on versionToken, sets conflictStatus to 'resolved', and advances the token. The unit must currently have conflictStatus 'conflict'; resolving a clean or already-resolved unit returns 400. This is the only way a conflict is resolved; uploads never resolve one. Non-selected takes are retained until the unit has been settled for the take retention window. Returns 409 if another writer advanced the token first.",
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
    return respondVerseAudioError(c, projectUnitId, bibleTextId, result.error);
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
    requireEditVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.PARAMS),
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
