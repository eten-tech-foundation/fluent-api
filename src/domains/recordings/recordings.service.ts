import { eq } from 'drizzle-orm';
import { Buffer } from 'node:buffer';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { logger } from '@/lib/logger';
import { uploadToR2 } from '@/lib/r2-upload';

import type { RecordingMetadata, UpsertRecordingData } from './recordings.types';

import * as repo from './recordings.repository';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncRecordingInput {
  projectUnitId: number;
  bibleTextId: number;
  relativePath: string;
  file: Blob;
  fileSizeRaw: unknown;
  recordedAtRaw: unknown;
  userId: number;
}

export interface SyncRecordingResult {
  transformedRelativePath: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Transforms the client-supplied relative path into a server-side R2 key:
 *   "<projectName>/<rest>"  →  "<projectUnitId>-<projectName>/<rest>"
 */
export function buildR2Key(relativePath: string, projectUnitId: number): string | null {
  const cleanPath = relativePath.replace(/^\/+/, '');
  const firstSlashIdx = cleanPath.indexOf('/');
  if (firstSlashIdx === -1) return null;

  const projectName = cleanPath.substring(0, firstSlashIdx);
  const rest = cleanPath.substring(firstSlashIdx + 1);
  return `${projectUnitId}-${projectName}/${rest}`;
}

/**
 * Builds the optional device metadata object from raw form-field values.
 */
export function buildMetadata(fileSizeRaw: unknown, recordedAtRaw: unknown): RecordingMetadata {
  const fileSize = fileSizeRaw != null ? Number(fileSizeRaw) : null;
  const recordedAt =
    typeof recordedAtRaw === 'string' && recordedAtRaw.trim()
      ? recordedAtRaw.trim()
      : new Date().toISOString();

  return { size: Number.isFinite(fileSize) ? fileSize : null, recorded_at: recordedAt };
}

// ─── Service functions ────────────────────────────────────────────────────────

/**
 * Verifies that the given projectUnitId exists in the database.
 * Returns true if found, false otherwise.
 */
export async function verifyProjectUnitExists(
  projectUnitId: number,
  userId: number
): Promise<boolean> {
  try {
    const result = await db
      .select({ id: schema.project_units.id })
      .from(schema.project_units)
      .where(eq(schema.project_units.id, projectUnitId))
      .limit(1);

    return result.length > 0;
  } catch (error) {
    logger.error('Failed to query project unit', { error, projectUnitId, userId });
    throw error;
  }
}

/**
 * Orchestrates the full audio sync workflow:
 *   1. Validates the project unit exists.
 *   2. Builds the R2 key from the relative path.
 *   3. Uploads the audio buffer to Cloudflare R2.
 *   4. Upserts the recording record in PostgreSQL.
 *
 * Returns the transformed R2 key on success.
 * Throws on any unrecoverable error so the route can map it to an HTTP response.
 */
export async function syncRecording(input: SyncRecordingInput): Promise<SyncRecordingResult> {
  const { projectUnitId, bibleTextId, relativePath, file, fileSizeRaw, recordedAtRaw, userId } =
    input;

  // 1. Verify project unit
  const exists = await verifyProjectUnitExists(projectUnitId, userId);
  if (!exists) {
    throw Object.assign(new Error('Project unit not found.'), { code: 'NOT_FOUND' });
  }

  // 2. Build R2 key
  const transformedRelativePath = buildR2Key(relativePath, projectUnitId);
  if (!transformedRelativePath) {
    throw Object.assign(new Error('Invalid relative_path format.'), { code: 'INVALID_PATH' });
  }

  // ── COMMENTED OUT — Assignment validation (pending model clarification) ─────
  //
  // Confirms the Bearer-token user is the assigned translator for this chapter.
  // Uncomment once the assignment model is finalised.
  //
  // const isAssigned = await repo.validateAssignment(projectUnitId, bibleTextId, userId);
  // if (!isAssigned) {
  //   logger.warn('Unauthorized upload attempt: user not assigned to chapter', {
  //     userId, projectUnitId, bibleTextId,
  //   });
  //   throw Object.assign(
  //     new Error('You are not assigned to this translation task.'),
  //     { code: 'FORBIDDEN' },
  //   );
  // }

  // 3. Upload to Cloudflare R2
  const audioBuffer = Buffer.from(await file.arrayBuffer());
  const contentType = file.type || 'audio/mp4';
  await uploadToR2(audioBuffer, transformedRelativePath, contentType);

  // 4. Upsert in PostgreSQL
  const metadata = buildMetadata(fileSizeRaw, recordedAtRaw);

  const upsertData: UpsertRecordingData = {
    projectUnitId,
    bibleTextId,
    relativePath: transformedRelativePath,
    recordedByUserId: userId,
    metadata,
  };

  try {
    await repo.upsertRecording(upsertData);
  } catch (error) {
    logger.error('DB upsert failed after successful R2 upload', {
      transformedRelativePath,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw Object.assign(new Error('Recording uploaded but failed to register in database.'), {
      code: 'DB_ERROR',
    });
  }

  logger.info('Recording synced successfully', {
    transformedRelativePath,
    userId,
    projectUnitId,
    bibleTextId,
    sizeBytes: audioBuffer.length,
  });

  return { transformedRelativePath };
}
