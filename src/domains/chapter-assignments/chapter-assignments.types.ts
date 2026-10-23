import { z } from '@hono/zod-openapi';

import type { selectChapterAssignmentsSchema } from '@/db/schema';
import type { TtsLicenseStatus } from '@/domains/bibles/bibles.types';

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

export type FixedChapterStatus =
  (typeof CHAPTER_ASSIGNMENT_STATUS)[keyof typeof CHAPTER_ASSIGNMENT_STATUS];
export type ChapterAssignmentStatus = FixedChapterStatus | (string & {});

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
  /** Whether anyone may synthesise speech from this Bible; never a user permission. */
  ttsLicenseStatus: TtsLicenseStatus;
  /** Provider-qualified text identity (`aq-`/`yv-`/`dbl-`), or null if unregistered. */
  textBibleKey: string | null;
  selectedRecordingKey: string | null;
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
  /**
   * ISO-8601 time the assignment entered its current status from status history,
   * or null when that entry cannot be proven. See `stageEnteredAtSchema`.
   */
  stageEnteredAt: string | null;
  isAiEnabled: boolean;
  hasClaimConflict: boolean;
  claimConflictUserId: number | null;
  /** Chapter-level rollup: any verse/pericope unit has unresolved audio take conflict. */
  hasConflict: boolean;
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

/** ISO-8601 datetime or null — truthful current-stage entry from status history. */
export const stageEnteredAtSchema = z.string().datetime().nullable().openapi({
  description:
    'ISO-8601 time when this assignment entered its current status, from chapter_assignment_status_history only. Null when there is no history, any history row has a null createdAt (conservative: unknown timestamps make stage entry unprovable), or the latest history status does not match the current status. Never derived from assignment createdAt, updatedAt, submittedTime, or activity. When every history createdAt is non-null: order by createdAt ASC, id ASC; value is the start of the trailing contiguous run of the current status (re-entry uses the latest run; repeated same-status rows do not reset entry).',
});

export const chapterAssignmentResponseSchema = z.object({
  id: z.number().int(),
  projectUnitId: z.number().int(),
  bibleId: z.number().int(),
  bookId: z.number().int(),
  chapterNumber: z.number().int(),
  assignedUserId: z.number().int().nullable().optional(),
  peerCheckerId: z.number().int().nullable().optional(),
  status: z.string().max(50).optional(),
  submittedTime: z.date().nullable().optional(),
  hasClaimConflict: z.boolean(),
  claimConflictUserId: z.number().int().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
  stageEnteredAt: stageEnteredAtSchema,
});

export type ChapterAssignmentResponse = z.infer<typeof chapterAssignmentResponseSchema>;
