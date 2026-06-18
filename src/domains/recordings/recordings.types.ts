import { z } from '@hono/zod-openapi';

// ─── Request / Domain types ───────────────────────────────────────────────────

export interface RecordingMetadata {
  size: number | null;
  recorded_at: string;
}

export interface UpsertRecordingData {
  projectUnitId: number;
  bibleTextId: number;
  relativePath: string;
  recordedByUserId: number;
  metadata?: RecordingMetadata;
}

// ─── Response schemas ─────────────────────────────────────────────────────────

export const syncSuccessSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  data: z.object({
    relative_path: z.string(),
  }),
});

// ─── Inferred types ───────────────────────────────────────────────────────────

export type SyncSuccessResponse = z.infer<typeof syncSuccessSchema>;
