import { z } from '@hono/zod-openapi';

import type { selectChapterAssignmentsSchema } from '@/db/schema';

// ─── Const enumerations ───────────────────────────────────────────────────────

export const CHAPTER_ASSIGNMENT_ACTIONS = {
  READ: 'read',
  UPDATE: 'update',
  SUBMIT: 'submit',
  DELETE: 'delete',
  IS_PARTICIPANT: 'isParticipant',
  TOGGLE_AI: 'toggleAi',
  CLAIM: 'claim',
} as const;

export type ChapterAssignmentAction =
  (typeof CHAPTER_ASSIGNMENT_ACTIONS)[keyof typeof CHAPTER_ASSIGNMENT_ACTIONS];

export const CHAPTER_ASSIGNMENT_STATUS = {
  NOT_STARTED: 'not_started',
  DRAFT: 'draft',
  PEER_CHECK: 'peer_check',
  COMMUNITY_REVIEW: 'community_review',
  LINGUIST_CHECK: 'linguist_check',
  THEOLOGICAL_CHECK: 'theological_check',
  CONSULTANT_CHECK: 'consultant_check',
  COMPLETE: 'complete',
} as const;

export type ChapterAssignmentStatus =
  (typeof CHAPTER_ASSIGNMENT_STATUS)[keyof typeof CHAPTER_ASSIGNMENT_STATUS];

/** Max age of a rival claim (via `updated_at`) for the race-loser policy branch. */
export const CLAIM_RACE_WINDOW_MS = 5 * 60 * 1000;

// ─── DB-derived types ─────────────────────────────────────────────────────────

export type ChapterAssignmentRecord = z.infer<typeof selectChapterAssignmentsSchema>;

export interface ChapterAssignmentRecordWithOrg extends ChapterAssignmentRecord {
  organizationId: number;
}

export interface ChapterAssignmentProgressInfo {
  assignmentId: number;
  projectId: number;
  projectName: string;
  projectUnitId: number;
  bibleId: number;
  bibleName: string | null;
  bookId: number;
  bookCode: string;
  bookNameEng: string;
  chapterNumber: number;
  status: string;
  /** Human-readable target language display NAME, e.g. "English". */
  targetLanguage: string | null;
  /**
   * ISO 639-3 target language CODE, e.g. "eng". Consumed by the repeated-words
   * check as greek-room's `lang_code` (which keys its legitimate-duplicate
   * whitelist on the ISO code). See phase-04 manual smoke (BUG #2).
   */
  targetLangCode: string | null;
  sourceLangCode: string | null;
  totalVerses: number;
  completedVerses: number;
  assignedUserId: number | null;
  assignedUserDisplayName: string | null;
  peerCheckerId: number | null;
  peerCheckerDisplayName: string | null;
  submittedTime: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  isAiEnabled: boolean;
  hasClaimConflict: boolean;
  claimConflictUserId: number | null;
}

// ─── Service input types ──────────────────────────────────────────────────────

export interface CreateChapterAssignmentRequestData {
  projectUnitId: number;
  bibleId: number;
  bookId: number;
  chapterNumber: number;
  assignedUserId?: number;
  peerCheckerId?: number;
}

export interface UpdateChapterAssignmentRequestData {
  assignedUserId?: number | null;
  peerCheckerId?: number | null;
  status?: ChapterAssignmentStatus;
  submittedTime?: Date;
  isAiEnabled?: boolean;
  hasClaimConflict?: boolean;
  claimConflictUserId?: number | null;
}

export const updateChapterAssignmentAiStatusSchema = z.object({
  isAiEnabled: z.boolean(),
});

// ─── API response schema ──────────────────────────────────────────────────────

export const chapterAssignmentResponseSchema = z.object({
  id: z.number().int(),
  projectUnitId: z.number().int(),
  bibleId: z.number().int(),
  bookId: z.number().int(),
  chapterNumber: z.number().int(),
  assignedUserId: z.number().int().nullable().optional(),
  peerCheckerId: z.number().int().nullable().optional(),
  status: z
    .enum(
      Object.values(CHAPTER_ASSIGNMENT_STATUS) as [
        ChapterAssignmentStatus,
        ...ChapterAssignmentStatus[],
      ]
    )
    .optional(),
  submittedTime: z.date().nullable().optional(),
  hasClaimConflict: z.boolean().optional(),
  claimConflictUserId: z.number().int().nullable().optional(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export type ChapterAssignmentResponse = z.infer<typeof chapterAssignmentResponseSchema>;
