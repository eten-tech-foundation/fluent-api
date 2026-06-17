import { createRoute, z } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import { Buffer } from 'node:buffer';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import * as HttpStatusPhrases from 'stoker/http-status-phrases';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { logger } from '@/lib/logger';
import { uploadToR2 } from '@/lib/r2-upload';
import { authenticateUser } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { upsertRecording } from './recordings.repository';

// ─── Response schema ──────────────────────────────────────────────────────────

const syncSuccessSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  data: z.object({
    relative_path: z.string(),
  }),
});

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

  // ── 2. Validate all fields are present and correctly typed ────────────────
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

  // ── 2.5 Verify projectUnitId exists and format transformed R2 path ────────
  try {
    const unitResult = await db
      .select({ id: schema.project_units.id })
      .from(schema.project_units)
      .where(eq(schema.project_units.id, projectUnitId))
      .limit(1);

    if (unitResult.length === 0) {
      return c.json({ message: 'Project unit not found.' }, HttpStatusCodes.BAD_REQUEST);
    }
  } catch (error) {
    logger.error('Failed to query project unit', { error, projectUnitId, userId: user.id });
    return c.json(
      { message: 'Failed to retrieve project information.' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    );
  }

  const cleanPath = relativePath.replace(/^\/+/, '');
  const firstSlashIdx = cleanPath.indexOf('/');
  if (firstSlashIdx === -1) {
    return c.json({ message: 'Invalid relative_path format.' }, HttpStatusCodes.BAD_REQUEST);
  }
  const projectName = cleanPath.substring(0, firstSlashIdx);
  const rest = cleanPath.substring(firstSlashIdx + 1);
  const transformedRelativePath = `${projectUnitId}-${projectName}/${rest}`;

  // ── 3. COMMENTED OUT — Assignment validation (pending model clarification) ─
  //
  // Confirms the Bearer-token user is the assigned translator for this chapter.
  // Uncomment once the assignment model is finalised.
  //
  // const isAssigned = await validateAssignment(projectUnitId, bibleTextId, user.id);
  // if (!isAssigned) {
  //   log.warn('Unauthorized upload attempt: user not assigned to chapter', {
  //     userId: user.id, projectUnitId, bibleTextId,
  //   });
  //   return c.json(
  //     { message: 'You are not assigned to this translation task.' },
  //     HttpStatusCodes.FORBIDDEN,
  //   );
  // }

  // ── 4. Read file into Buffer ───────────────────────────────────────────────
  let audioBuffer: Buffer;
  try {
    audioBuffer = Buffer.from(await file.arrayBuffer());
  } catch (error) {
    logger.error('Failed to read uploaded file into buffer', { error, userId: user.id });
    return c.json(
      { message: 'Failed to read the uploaded file.' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    );
  }

  // ── 5. Upload to Cloudflare R2 ─────────────────────────────────────────────
  const contentType = file.type || 'audio/mp4';
  try {
    await uploadToR2(audioBuffer, transformedRelativePath, contentType);
  } catch (error) {
    logger.error('R2 upload failed', {
      transformedRelativePath,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { message: 'Failed to upload recording to cloud storage.' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    );
  }

  // ── 6. Register in PostgreSQL ──────────────────────────────────────────────
  // R2 upload already succeeded at this point.
  // A failure here is logged but does not roll back the R2 object —
  // the client will retry and the upsert will refresh the timestamp.

  // Build optional device metadata if the mobile client provided it
  const fileSize = fileSizeRaw != null ? Number(fileSizeRaw) : null;
  const recordedAt =
    typeof recordedAtRaw === 'string' && recordedAtRaw.trim()
      ? recordedAtRaw.trim()
      : new Date().toISOString();
  const metadata = { size: Number.isFinite(fileSize) ? fileSize : null, recorded_at: recordedAt };

  try {
    await upsertRecording({
      projectUnitId,
      bibleTextId,
      relativePath: transformedRelativePath,
      recordedByUserId: user.id, // ← from Bearer token, never from request body
      metadata,
    });
  } catch (error) {
    logger.error('DB upsert failed after successful R2 upload', {
      transformedRelativePath,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { message: 'Recording uploaded but failed to register in database.' },
      HttpStatusCodes.INTERNAL_SERVER_ERROR
    );
  }

  // ── 7. Return success ──────────────────────────────────────────────────────
  logger.info('Recording synced successfully', {
    transformedRelativePath,
    userId: user.id,
    projectUnitId,
    bibleTextId,
    sizeBytes: audioBuffer.length,
  });

  return c.json(
    {
      success: true as const,
      message: 'Audio recording synchronized and saved cleanly.',
      data: { relative_path: transformedRelativePath },
    },
    HttpStatusCodes.OK
  );
});
