import { z } from '@hono/zod-openapi';

import type { selectChapterAssignmentsSchema } from '@/db/schema';

// ─── Const enumerations ───────────────────────────────────────────────────────

export const CHAPTER_ASSIGNMENT_ACTIONS = {
  READ: 'read',
  UPDATE: 'update',
  SUBMIT: 'submit',
  DELETE: 'delete',
  IS_PARTICIPANT: 'isParticipant',
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

// ─── DB-derived types ─────────────────────────────────────────────────────────

export type ChapterAssignmentRecord = z.infer<typeof selectChapterAssignmentsSchema>;

export interface ChapterAssignmentRecordWithOrg extends ChapterAssignmentRecord {
  organizationId: number;
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
  assignedUserId?: number;
  peerCheckerId?: number;
  status?: ChapterAssignmentStatus;
  submittedTime?: Date;
}

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
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export type ChapterAssignmentResponse = z.infer<typeof chapterAssignmentResponseSchema>;
