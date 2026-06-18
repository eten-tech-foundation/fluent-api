import { sql } from 'drizzle-orm';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { logger } from '@/lib/logger';

import type { UpsertRecordingData } from './recordings.types';

// ─── Queries ──────────────────────────────────────────────────────────────────

export async function upsertRecording(
  data: UpsertRecordingData
): Promise<{ relativePath: string }> {
  const { projectUnitId, bibleTextId, relativePath, recordedByUserId, metadata } = data;

  await db
    .insert(schema.recordings)
    .values({
      projectUnitId,
      bibleTextId,
      relativePath,
      recordedByUserId,
      metadata: metadata ?? null,
    })
    .onConflictDoUpdate({
      target: schema.recordings.relativePath,
      set: {
        metadata: sql`excluded.metadata`,
        createdAt: sql`now()`,
      },
    });

  logger.info('Recording upserted in DB', { relativePath, projectUnitId, bibleTextId });

  return { relativePath };
}

// ─── COMMENTED OUT — assignment validation (pending model clarification) ───────
//
// Validates that the calling user is the assigned translator for the chapter
// that contains the given bible_text_id + project_unit_id pair.
//
// export async function validateAssignment(
//   projectUnitId: number,
//   bibleTextId: number,
//   userId: number,
// ): Promise<boolean> {
//   const rows = await db
//     .select({ id: schema.chapter_assignments.id })
//     .from(schema.chapter_assignments)
//     .innerJoin(
//       schema.bible_texts,
//       and(
//         eq(schema.bible_texts.bibleId,       schema.chapter_assignments.bibleId),
//         eq(schema.bible_texts.bookId,         schema.chapter_assignments.bookId),
//         eq(schema.bible_texts.chapterNumber,  schema.chapter_assignments.chapterNumber),
//       ),
//     )
//     .where(
//       and(
//         eq(schema.chapter_assignments.projectUnitId,    projectUnitId),
//         eq(schema.bible_texts.id,                       bibleTextId),
//         eq(schema.chapter_assignments.assignedUserId,   userId),
//       ),
//     )
//     .limit(1);
//
//   return rows.length > 0;
// }
