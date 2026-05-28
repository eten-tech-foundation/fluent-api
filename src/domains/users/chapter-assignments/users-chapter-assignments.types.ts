import { z } from '@hono/zod-openapi';

// ─── DB-derived types ─────────────────────────────────────────────────────────
export interface UserChapterAssignment {
  chapterAssignmentId: number;
  projectId: number;
  projectName: string;
  projectUnitId: number;
  bibleId: number;
  bibleName: string;
  chapterStatus: string;
  targetLanguage: string;
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
}

// ─── API response schema ──────────────────────────────────────────────────────
export const userChapterAssignmentResponseSchema = z.object({
  chapterAssignmentId: z.number().int(),
  projectId: z.number().int(),
  projectName: z.string(),
  projectUnitId: z.number().int(),
  bibleId: z.number().int(),
  bibleName: z.string(),
  chapterStatus: z.string(),
  targetLanguage: z.string(),
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
});

export const userChapterAssignmentsByUserResponseSchema = z.object({
  assignedChapters: userChapterAssignmentResponseSchema.array(),
  peerCheckChapters: userChapterAssignmentResponseSchema.array(),
});

export type UserChapterAssignmentResponse = z.infer<typeof userChapterAssignmentResponseSchema>;

export type UserChapterAssignmentsByUserResponse = z.infer<
  typeof userChapterAssignmentsByUserResponseSchema
>;
