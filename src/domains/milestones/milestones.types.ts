import { z } from '@hono/zod-openapi';

import { patchProjectUnitsSchema, projectStatusEnum, selectProjectUnitsSchema } from '@/db/schema';

export const milestoneResponseSchema = selectProjectUnitsSchema
  .extend({
    bookCount: z.number().int().optional(),
    chapterStatusCounts: z.record(z.string(), z.number()).optional(),
  })
  .openapi('Milestone');

export const createMilestoneSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.string().min(1).max(50),
  status: z.enum(projectStatusEnum.enumValues).default('not_started'),
  bibleId: z.number().int(),
  bookIds: z
    .array(z.number().int())
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, 'Duplicate book IDs not allowed'),
});

export const updateMilestoneSchema = patchProjectUnitsSchema.extend({
  name: z.string().min(1).max(255).optional(),
  type: z.string().min(1).max(50).optional(),
  status: z.enum(projectStatusEnum.enumValues).optional(),
  bibleId: z.number().int().optional(),
  addBooks: z
    .array(z.number().int())
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, 'Duplicate book IDs not allowed')
    .optional(),
  removeBooks: z
    .array(z.number().int())
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, 'Duplicate book IDs not allowed')
    .optional(),
  moveBooks: z
    .array(
      z.object({
        bookId: z.number().int(),
        targetMilestoneId: z.number().int(),
      })
    )
    .min(1)
    .optional(),
});

export type Milestone = z.infer<typeof milestoneResponseSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
