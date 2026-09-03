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
} as const;

export type VerseAudioConflictStatus =
  (typeof VERSE_AUDIO_CONFLICT_STATUS)[keyof typeof VERSE_AUDIO_CONFLICT_STATUS];

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
  activeTakeId: number | null;
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
  activeTakeId: number | null;
  verseNumber: number;
  downloadUrl: string;
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
}

export interface InsertTakeInput {
  recordingId: number;
  uploadedBy: number;
  storageObjectId: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds?: number | null;
  contentHash: string;
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
}

export interface ResolveConflictInput {
  projectUnitId: number;
  bibleTextId: number;
  takeId: number;
}

// ── OpenAPI schemas ──────────────────────────────────────────────────────────

export const verseAudioTakeResponseSchema = z.object({
  id: z.number().int(),
  uploadedBy: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().nullable(),
  contentHash: z.string(),
  downloadUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const verseAudioResponseSchema = z.object({
  id: z.number().int(),
  projectUnitId: z.number().int(),
  bibleTextId: z.number().int(),
  uploadedBy: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().nullable(),
  versionToken: z.number().int(),
  conflictStatus: z.enum(['clean', 'conflict']),
  activeTakeId: z.number().int().nullable(),
  verseNumber: z.number().int(),
  downloadUrl: z.string(),
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

export const VERSE_AUDIO_ACTIONS = {
  READ: 'read',
  EDIT: 'edit',
} as const;

export type VerseAudioAction = (typeof VERSE_AUDIO_ACTIONS)[keyof typeof VERSE_AUDIO_ACTIONS];

export const VERSE_AUDIO_ID_SOURCES = {
  PARAMS: 'params',
  QUERY: 'query',
} as const;

export type VerseAudioIdSource =
  (typeof VERSE_AUDIO_ID_SOURCES)[keyof typeof VERSE_AUDIO_ID_SOURCES];
