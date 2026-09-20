import { z } from '@hono/zod-openapi';

import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';

import { ttsLicenseStatusSchema } from '@/domains/bibles/bibles.types';

// ─── DB-derived types ─────────────────────────────────────────────────────────
export interface UserChapterAssignment {
  chapterAssignmentId: number;
  projectId: number;
  projectName: string;
  projectUnitId: number;
  bibleId: number;
  bibleName: string;
  /** Whether anyone may synthesise speech from this Bible; never a user permission. */
  ttsLicenseStatus: TtsLicenseStatus;
  /** Human-curated attribution for this Bible, shown with its audio. */
  textBibleKey: string | null;
  selectedRecordingKey: string | null;
  chapterStatus: string;
  /** Human-readable target language display NAME, e.g. "English". */
  targetLanguage: string;
  /** ISO 639-3 target language CODE, e.g. "eng" (the check's lang_code). */
  targetLangCode: string;
  sourceLangCode: string;
  bookCode: string;
  bookId: number;
  book: string;
  chapterNumber: number;
  totalVerses: number;
  completedVerses: number;
  submittedTime: string | null;
  assignedUserId: number | null;
  peerCheckerId: number | null;
  updatedAt: string | null;
  isAiEnabled: boolean;
  hasClaimConflict: boolean;
  claimConflictUserId: number | null;
  hasConflict: boolean;
}

// ─── API response schema ──────────────────────────────────────────────────────
export const userChapterAssignmentResponseSchema = z.object({
  chapterAssignmentId: z.number().int(),
  projectId: z.number().int(),
  projectName: z.string(),
  projectUnitId: z.number().int(),
  bibleId: z.number().int(),
  bibleName: z.string(),
  // The drafting page reads the source Bible's audio licence from the
  // assignment it already loads, so the answer is in hand before any audio
  // provider is called — and stays in hand when one is unreachable.
  ttsLicenseStatus: ttsLicenseStatusSchema,
  textBibleKey: z.string().nullable(),
  selectedRecordingKey: z.string().nullable(),
  chapterStatus: z.string(),
  targetLanguage: z.string(),
  targetLangCode: z.string(),
  sourceLangCode: z.string(),
  bookCode: z.string(),
  bookId: z.number().int(),
  book: z.string(),
  chapterNumber: z.number().int(),
  totalVerses: z.number().int(),
  completedVerses: z.number().int(),
  submittedTime: z.string().nullable(),
  assignedUserId: z.number().int().nullable(),
  peerCheckerId: z.number().int().nullable(),
  updatedAt: z.string().nullable(),
  isAiEnabled: z.boolean(),
  hasClaimConflict: z.boolean(),
  claimConflictUserId: z.number().int().nullable(),
  hasConflict: z.boolean(),
});

export const userChapterAssignmentsByUserResponseSchema = z.object({
  assignedChapters: userChapterAssignmentResponseSchema.array(),
  peerCheckChapters: userChapterAssignmentResponseSchema.array(),
});

export type UserChapterAssignmentResponse = z.infer<typeof userChapterAssignmentResponseSchema>;

export type UserChapterAssignmentsByUserResponse = z.infer<
  typeof userChapterAssignmentsByUserResponseSchema
>;

export const memberChapterAssignmentResponseSchema = z.object({
  chapterAssignmentId: z.number().int(),
  projectId: z.number().int(),
  projectUnitId: z.number().int(),
  bibleId: z.number().int(),
  bookId: z.number().int(),
  chapterNumber: z.number().int(),
  assignedUserId: z.number().int().nullable(),
  peerCheckerId: z.number().int().nullable(),
  status: z.string(),
  submittedTime: z.date().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
  hasClaimConflict: z.boolean(),
  claimConflictUserId: z.number().int().nullable(),
});

export const memberChapterAssignmentsResponseSchema = z.object({
  syncedAt: z.date(),
  data: memberChapterAssignmentResponseSchema.array(),
});
