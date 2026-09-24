import { z } from '@hono/zod-openapi';

import { projectStatusEnum } from '@/db/schema';

import { chapterStatusCountsSchema } from '../projects/projects.types';

export interface MilestoneRow {
  id: number;
  name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  type: 'text' | 'audio';
  projectId: number;
  projectName: string;
  milestoneCount: number;
  bookCount: number;
  bookIds: number[];
  chapterStatusCounts: Record<string, number>;
  createdAt: string | null;
  updatedAt: string | null;
}

export const milestoneResponseSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    status: z.enum(projectStatusEnum.enumValues),
    type: z.enum(['text', 'audio']),
    projectId: z.number().int(),
    projectName: z.string(),
    milestoneCount: z.number().int().min(0),
    bookCount: z.number().int().min(0),
    bookIds: z.array(z.number().int()),
    chapterStatusCounts: chapterStatusCountsSchema,
    createdAt: z.string().nullable().optional(),
    updatedAt: z.string().nullable().optional(),
  })
  .openapi('Milestone');

export const createMilestoneSchema = z.object({
  name: z.string().min(1).max(255),
  type: z.enum(['text', 'audio']).default('text'),
  status: z.enum(projectStatusEnum.enumValues).default('not_started'),
  bookIds: z
    .array(z.number().int().positive())
    .min(1)
    .refine((arr) => new Set(arr).size === arr.length, 'Duplicate book IDs not allowed'),
});

export const updateMilestoneSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    type: z.enum(['text', 'audio']).optional(),
    status: z.enum(projectStatusEnum.enumValues).optional(),
    addBooks: z
      .array(z.number().int().positive())
      .min(1)
      .refine((arr) => new Set(arr).size === arr.length, 'Duplicate book IDs not allowed')
      .optional(),
    removeBooks: z
      .array(z.number().int().positive())
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
      .refine(
        (arr) => new Set(arr.map((item) => item.bookId)).size === arr.length,
        'Duplicate book IDs not allowed'
      )
      .optional(),
  })
  .refine(
    (data) => {
      const hasMove = data.moveBooks && data.moveBooks.length > 0;
      const hasAdd = data.addBooks && data.addBooks.length > 0;
      const hasRemove = data.removeBooks && data.removeBooks.length > 0;
      const ops = [hasMove, hasAdd, hasRemove].filter(Boolean).length;
      return ops <= 1;
    },
    {
      message: 'Cannot combine moveBooks, addBooks, or removeBooks in the same request',
    }
  );

export const projectIdParamSchema = z.object({
  projectId: z.coerce.number().int().positive(),
});

export const milestonePathParamsSchema = projectIdParamSchema.extend({
  milestoneId: z.coerce.number().int().positive(),
});

export type Milestone = z.infer<typeof milestoneResponseSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
