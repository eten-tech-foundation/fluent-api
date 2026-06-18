import { createRoute } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { logger } from '@/lib/logger';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import * as service from './recordings.service';
import { syncSuccessSchema } from './recordings.types';

// ─── Route definition ─────────────────────────────────────────────────────────

const syncRecordingRoute = createRoute({
  tags: ['Recordings'],
  method: 'post',
  path: '/recordings/sync',
  middleware: [authenticateUser] as const,
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      syncSuccessSchema,
      'Recording uploaded to Cloudflare R2 and registered in the database.'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Missing or invalid form fields.'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Missing or invalid Bearer token.'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'User account is inactive.'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: jsonContent(
      createMessageObjectSchema(HttpStatusPhrases.INTERNAL_SERVER_ERROR),
      'R2 upload or database error.'
    ),
  },
  summary: 'Sync a mobile audio recording to cloud storage',
  description:
    'Accepts multipart/form-data with fields: `project_unit_id` (text), ' +
    '`bible_text_id` (text), `relative_path` (text), `file` (binary .m4a), ' +
    '`file_size` (text, optional), `recorded_at` (ISO 8601 text, optional). ' +
    "The caller's identity is resolved entirely from the Authorization Bearer token — " +
    'no user_id field is accepted in the request body.',
});

// ─── Handler ──────────────────────────────────────────────────────────────────

server.openapi(syncRecordingRoute, async (c) => {
  const user = c.get('user')!;

  // ── 1. Parse multipart body ────────────────────────────────────────────────
  let body: Record<string, string | File | Blob>;
  try {
    body = await c.req.parseBody();
  } catch {
    logger.warn('Failed to parse multipart body', { userId: user.id });
    return c.json({ message: 'Invalid multipart request body.' }, HttpStatusCodes.BAD_REQUEST);
  }

  const projectUnitIdRaw = (body as any).project_unit_id;
  const bibleTextIdRaw = (body as any).bible_text_id;
  const relativePath = (body as any).relative_path;
  const file = (body as any).file;
  const fileSizeRaw = (body as any).file_size;
  const recordedAtRaw = (body as any).recorded_at;

  // ── 2. Validate required fields ────────────────────────────────────────────
  if (
    typeof projectUnitIdRaw !== 'string' ||
    typeof bibleTextIdRaw !== 'string' ||
    typeof relativePath !== 'string' ||
    !(file instanceof Blob)
  ) {
    return c.json(
      { message: 'Missing required fields: project_unit_id, bible_text_id, relative_path, file.' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  const projectUnitId = Number(projectUnitIdRaw);
  const bibleTextId = Number(bibleTextIdRaw);

  if (!Number.isInteger(projectUnitId) || projectUnitId <= 0) {
    return c.json(
      { message: 'project_unit_id must be a positive integer.' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  if (!Number.isInteger(bibleTextId) || bibleTextId <= 0) {
    return c.json(
      { message: 'bible_text_id must be a positive integer.' },
      HttpStatusCodes.BAD_REQUEST
    );
  }

  if (!relativePath.trim()) {
    return c.json({ message: 'relative_path must not be empty.' }, HttpStatusCodes.BAD_REQUEST);
  }

  // ── 3. Delegate to service ─────────────────────────────────────────────────
  try {
    const { transformedRelativePath } = await service.syncRecording({
      projectUnitId,
      bibleTextId,
      relativePath,
      file,
      fileSizeRaw,
      recordedAtRaw,
      userId: user.id,
    });

    return c.json(
      {
        success: true as const,
        message: 'Audio recording synchronized and saved cleanly.',
        data: { relative_path: transformedRelativePath },
      },
      HttpStatusCodes.OK
    );
  } catch (error: any) {
    if (error?.code === 'NOT_FOUND') {
      return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST);
    }
    if (error?.code === 'INVALID_PATH') {
      return c.json({ message: error.message }, HttpStatusCodes.BAD_REQUEST);
    }
    if (error?.code === 'FORBIDDEN') {
      return c.json({ message: error.message }, HttpStatusCodes.FORBIDDEN);
    }
    logger.error('Recording sync failed', {
      userId: user.id,
      projectUnitId,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { message: error?.message ?? 'An unexpected error occurred.' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    );
  }
});
