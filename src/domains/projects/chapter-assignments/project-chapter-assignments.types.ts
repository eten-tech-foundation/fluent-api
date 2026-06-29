import { z } from '@hono/zod-openapi';

import type { ChapterAssignmentRecord } from '@/domains/chapter-assignments/chapter-assignments.types';

import { chapterAssignmentResponseSchema as sharedAssignmentSchema } from '@/domains/chapter-assignments/chapter-assignments.types';

// ─── Shared response schemas ──────────────────────────────────────────────────

export const userResponseSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
});

export const chapterAssignmentResponseSchema = sharedAssignmentSchema;

export const chapterAssignmentProgressResponseSchema = z.object({
  assignmentId: z.number(),
  projectUnitId: z.number(),
  bibleId: z.number(),
  bookId: z.number(),
  bookCode: z.string(),
  sourceLangCode: z.string(),
  status: z.string(),
  bookNameEng: z.string(),
  chapterNumber: z.number(),
  assignedUser: z.nullable(userResponseSchema),
  peerChecker: z.nullable(userResponseSchema),
  totalVerses: z.number().int(),
  completedVerses: z.number().int(),
  submittedTime: z.date().nullable(),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
  isAiEnabled: z.boolean(),
});

// ─── Assign-all input ─────────────────────────────────────────────────────────

export const assignUserInputSchema = z
  .object({
    assignedUserId: z.number().int().optional(),
    peerCheckerId: z.number().int().optional(),
  })
  .refine((data) => data.assignedUserId !== undefined || data.peerCheckerId !== undefined, {
    message: 'At least one of assignedUserId or peerCheckerId must be provided',
  });

// ─── Assign-selected input / response ────────────────────────────────────────

export const assignSelectedItemSchema = z.object({
  chapterAssignmentId: z.number().int().positive(),
  drafterId: z.number().int().positive().nullable(),
  peerCheckerId: z.number().int().positive().nullable(),
});

export const assignSelectedRequestSchema = z.object({
  assignments: z
    .array(assignSelectedItemSchema)
    .min(1, 'At least one assignment is required')
    .refine(
      (items) => {
        const ids = items.map((i) => i.chapterAssignmentId);
        return new Set(ids).size === ids.length;
      },
      { message: 'Duplicate chapterAssignmentIds are not allowed' }
    )
    .refine(
      (items) =>
        items.every(
          (i) =>
            !(i.drafterId !== null && i.peerCheckerId !== null && i.drafterId === i.peerCheckerId)
        ),
      { message: 'A user cannot be both drafter and peer checker on the same assignment' }
    ),
});

// Response reuses the progress shape so the frontend gets the same structure
// it already knows how to render.
export const assignSelectedResponseSchema = z
  .array(chapterAssignmentProgressResponseSchema)
  .openapi('AssignSelectedChapterAssignments');

// ─── Inferred types ───────────────────────────────────────────────────────────

export type AssignmentUser = z.infer<typeof userResponseSchema>;
export type ChapterAssignmentResponse = z.infer<typeof chapterAssignmentResponseSchema>;
export type ChapterAssignmentProgress = z.infer<typeof chapterAssignmentProgressResponseSchema>;
export type AssignUserInput = z.infer<typeof assignUserInputSchema>;
export type AssignSelectedItem = z.infer<typeof assignSelectedItemSchema>;
export type AssignSelectedRequest = z.infer<typeof assignSelectedRequestSchema>;
export type ChapterAssignmentWithProjectId = ChapterAssignmentRecord & { projectId: number };
