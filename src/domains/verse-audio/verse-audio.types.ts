import type { Buffer } from 'node:buffer';

import { z } from '@hono/zod-openapi';

// ── Limits & formats ─────────────────────────────────────────────────────────

export const MAX_AUDIO_BYTES = 30 * 1024 * 1024; // 30 MB

// Covers React Native recorders (m4a/aac/mp4) and web MediaRecorder (webm/ogg),
// plus mp3/wav for imported files.
export const ALLOWED_AUDIO_CONTENT_TYPES = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/webm',
  'audio/wav',
  'audio/ogg',
]);

export const VERSE_AUDIO_CONFLICT_STATUS = {
  CLEAN: 'clean',
  CONFLICT: 'conflict',
  /** Conflict was resolved via POST /resolve — distinct from 'clean' (never conflicted). */
  RESOLVED: 'resolved',
} as const;

export type VerseAudioConflictStatus =
  (typeof VERSE_AUDIO_CONFLICT_STATUS)[keyof typeof VERSE_AUDIO_CONFLICT_STATUS];

export const VERSE_AUDIO_GRANULARITY = {
  VERSE: 'verse',
  PERICOPE: 'pericope',
} as const;

export type VerseAudioGranularity =
  (typeof VERSE_AUDIO_GRANULARITY)[keyof typeof VERSE_AUDIO_GRANULARITY];

/** Coverage shape persisted on a take and denormalized onto the active recording. */
export interface VerseAudioCoverageShape {
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
}

export const VERSE_COVERAGE_SHAPE: VerseAudioCoverageShape = {
  granularity: VERSE_AUDIO_GRANULARITY.VERSE,
  startChapter: null,
  startVerse: null,
  endChapter: null,
  endVerse: null,
};

// ── Records ──────────────────────────────────────────────────────────────────

export interface VerseAudioTakeRecord {
  id: number;
  recordingId: number;
  uploadedBy: number;
  storageObjectId: number | null;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  contentHash: string;
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerseAudioRecord {
  id: number;
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  /** Row in storage_objects that tracks the active take bytes, for orphan reclaim. */
  storageObjectId: number | null;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  versionToken: number;
  conflictStatus: VerseAudioConflictStatus;
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
  activeTakeId: number | null;
  /** From bible_texts join — anchor verse location for coverage / listing. */
  bookId: number;
  chapterNumber: number;
  verseNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerseAudioTakeWithUrl {
  id: number;
  uploadedBy: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  contentHash: string;
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
  downloadUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** What routes return: storageObjectId is internal bookkeeping, never on the wire. */
export interface VerseAudioWithUrl {
  id: number;
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  versionToken: number;
  conflictStatus: VerseAudioConflictStatus;
  granularity: VerseAudioGranularity;
  startChapter: number | null;
  startVerse: number | null;
  endChapter: number | null;
  endVerse: number | null;
  activeTakeId: number | null;
  verseNumber: number;
  /**
   * Short-lived URL for the exact active take (`takes[].id === activeTakeId`).
   * Null when activeTakeId is null or does not match any take — never invents
   * a last-take / top-level fallback.
   */
  downloadUrl: string | null;
  takes: VerseAudioTakeWithUrl[];
  createdAt: string;
  updatedAt: string;
}

export interface UpsertVerseAudioInput {
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  storageObjectId: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds?: number | null;
  versionToken: number;
  conflictStatus: VerseAudioConflictStatus;
  activeTakeId: number | null;
  granularity?: VerseAudioGranularity;
  startChapter?: number | null;
  startVerse?: number | null;
  endChapter?: number | null;
  endVerse?: number | null;
}

export interface InsertTakeInput {
  recordingId: number;
  uploadedBy: number;
  storageObjectId: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds?: number | null;
  contentHash: string;
  granularity?: VerseAudioGranularity;
  startChapter?: number | null;
  startVerse?: number | null;
  endChapter?: number | null;
  endVerse?: number | null;
}

export interface UploadRecordingInput {
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  data: Buffer;
  durationSeconds?: number;
  /** Client's last-known unit version (starts at 1). Omit for legacy replace; stale → conflict. */
  baseVersionToken?: number;
  /** Take coverage. Defaults to single-verse (null range bounds). */
  shape?: VerseAudioCoverageShape;
}

export interface UploadRangeRecordingInput {
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  data: Buffer;
  durationSeconds?: number;
  baseVersionToken?: number;
  granularity: typeof VERSE_AUDIO_GRANULARITY.PERICOPE;
  startChapter: number;
  startVerse: number;
  endChapter: number;
  endVerse: number;
}

export interface ResolveConflictInput {
  projectUnitId: number;
  bibleTextId: number;
  takeId: number;
}

// ── OpenAPI schemas ──────────────────────────────────────────────────────────

const nullablePositiveInt = z.number().int().positive().nullable();

export const verseAudioTakeResponseSchema = z.object({
  id: z.number().int(),
  uploadedBy: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().nullable(),
  contentHash: z.string().openapi({
    description:
      'Stable content identity for this take. Selected-canonical clients bind cache keys to activeTakeId + this hash.',
  }),
  granularity: z.enum(['verse', 'pericope']).openapi({
    description:
      'Recorded-unit granularity for this take. Verse responses hydrate inclusive start/end anchors from the shared bible_texts identity; pericope uses persisted range bounds.',
  }),
  startChapter: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage start chapter. For granularity=verse this is the anchor chapter (hydrated on read).',
  }),
  startVerse: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage start verse. For granularity=verse this is the anchor verse (hydrated on read).',
  }),
  endChapter: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage end chapter. May differ from startChapter for cross-chapter pericopes.',
  }),
  endVerse: nullablePositiveInt.openapi({
    description: 'Inclusive coverage end verse.',
  }),
  downloadUrl: z.string().openapi({
    description: 'Short-lived read-only URL for this take (valid ~15 minutes).',
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const verseAudioResponseSchema = z.object({
  id: z.number().int().openapi({
    description:
      'Recording row id. Stable unit identity with projectUnitId + bibleTextId (anchor).',
  }),
  projectUnitId: z.number().int(),
  bibleTextId: z.number().int().openapi({
    description:
      'Shared anchored recording identity: bible_texts.id of the first verse (pericope start / single verse).',
  }),
  uploadedBy: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().nullable(),
  versionToken: z.number().int(),
  conflictStatus: z.enum(['clean', 'conflict', 'resolved']).openapi({
    description:
      'Preserved conflict truth. Matching-base / legacy upload may advance activeTakeId while status remains conflict; only POST .../resolve marks resolved. Not a playback-policy signal.',
  }),
  granularity: z.enum(['verse', 'pericope']).openapi({
    description:
      'Selected-canonical recorded-unit granularity from the exact active take when activeTakeId matches; otherwise from denormalized recording state.',
  }),
  startChapter: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage start chapter. Verse units hydrate the bible_texts anchor chapter on read.',
  }),
  startVerse: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage start verse. Verse units hydrate the bible_texts anchor verse on read.',
  }),
  endChapter: nullablePositiveInt.openapi({
    description:
      'Inclusive coverage end chapter (cross-chapter pericopes supported when endChapter > startChapter).',
  }),
  endVerse: nullablePositiveInt.openapi({
    description: 'Inclusive coverage end verse.',
  }),
  activeTakeId: z.number().int().nullable().openapi({
    description:
      'Selected take id. Clients must match takes[].id exactly; null or unmatched means selected audio is unavailable.',
  }),
  verseNumber: z.number().int().openapi({
    description: 'Anchor verse number from bible_texts (listing order / identity aid).',
  }),
  downloadUrl: z.string().nullable().openapi({
    description:
      'Short-lived URL for the exact active take only (takes[].id === activeTakeId). Null when activeTakeId is null or unmatched — never a last-take invent fallback.',
  }),
  takes: z.array(verseAudioTakeResponseSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const verseAudioListResponseSchema = z.object({
  items: z.array(verseAudioResponseSchema),
  hasConflict: z.boolean(),
});

export const resolveConflictBodySchema = z.object({
  takeId: z.number().int().positive().openapi({
    description: 'Take id to designate as the active recording',
    example: 42,
  }),
});

/** 409 body for CAS / cleanup races — includes the live token so clients can retry without a GET. */
export const verseAudioVersionConflictSchema = z.object({
  message: z.string(),
  currentVersionToken: z.number().int().positive().optional().openapi({
    description:
      'Live server token after the concurrent write; send as baseVersionToken on retry. Omitted only when the recording no longer exists.',
    example: 4,
  }),
});

// ── Const enumerations ───────────────────────────────────────────────────────

export const VERSE_AUDIO_ID_SOURCES = {
  PARAMS: 'params',
  QUERY: 'query',
  /** Multipart form body — used by PUT /verse-audio/{projectUnitId}/range only. */
  FORM: 'form',
} as const;

export type VerseAudioIdSource =
  (typeof VERSE_AUDIO_ID_SOURCES)[keyof typeof VERSE_AUDIO_ID_SOURCES];
