import { z } from '@hono/zod-openapi';

import { chapterStatusEnum } from '@/db/schema';

const chapterStatusCountsSchema = z.object(
  chapterStatusEnum.enumValues.reduce(
    (acc, status) => {
      acc[status] = z.number().int().min(0);
      return acc;
    },
    {} as Record<string, z.ZodNumber>
  )
);

export const milestoneResponseSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  status: z.enum(['not_started', 'in_progress', 'completed']),
  type: z.enum(['text', 'audio']),
  connectivityProfile: z.string().nullable(),
  projectId: z.number().int(),
  projectName: z.string(),
  milestoneCount: z.number().int().min(0),
  bookCount: z.number().int().min(0),
  bookIds: z.array(z.number().int()),
  chapterStatusCounts: chapterStatusCountsSchema,
});

export const createMilestoneSchema = z.object({
  name: z.string().min(1).max(255),
  bookId: z
    .array(z.number().int())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Book IDs must be unique',
    }),
  type: z.enum(['text', 'audio']).default('text'),
  connectivityProfile: z.string().max(255).nullable().optional(),
  status: z.enum(['not_started', 'in_progress', 'completed']).default('not_started'),
});

export const updateMilestoneSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  status: z.enum(['not_started', 'in_progress', 'completed']).optional(),
  type: z.enum(['text', 'audio']).optional(),
  connectivityProfile: z.string().max(255).nullable().optional(),
});

export const projectIdParamSchema = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectId', in: 'path', required: true },
    }),
});

export const milestonePathParamsSchema = projectIdParamSchema.extend({
  milestoneId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'milestoneId', in: 'path', required: true },
    }),
});

export type MilestoneResponse = z.infer<typeof milestoneResponseSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;

export interface MilestoneRow {
  id: number;
  name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  type: 'text' | 'audio';
  connectivityProfile: string | null;
  projectId: number;
  projectName: string;
  milestoneCount: number;
  bookCount: number;
  bookIds: number[];
  chapterStatusCounts: Record<string, number>;
}
