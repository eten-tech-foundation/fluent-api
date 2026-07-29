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

// ── Records ──────────────────────────────────────────────────────────────────

export interface VerseAudioRecord {
  id: number;
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds: number | null;
  verseNumber: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface VerseAudioWithUrl extends VerseAudioRecord {
  downloadUrl: string;
}

export interface UpsertVerseAudioInput {
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  sizeBytes: number;
  durationSeconds?: number | null;
}

export interface UploadRecordingInput {
  projectUnitId: number;
  bibleTextId: number;
  uploadedBy: number;
  contentType: string;
  data: Buffer;
  durationSeconds?: number;
}

// ── OpenAPI schemas ──────────────────────────────────────────────────────────

export const verseAudioResponseSchema = z.object({
  id: z.number().int(),
  projectUnitId: z.number().int(),
  bibleTextId: z.number().int(),
  uploadedBy: z.number().int(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  durationSeconds: z.number().nullable(),
  verseNumber: z.number().int(),
  downloadUrl: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const verseAudioListResponseSchema = z.object({
  items: z.array(verseAudioResponseSchema),
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
