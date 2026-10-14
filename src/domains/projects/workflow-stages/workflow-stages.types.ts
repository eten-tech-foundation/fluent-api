import { z } from '@hono/zod-openapi';

export const workflowStepResponseSchema = z.object({
  id: z.string().describe('Stable string identifier (defaultName)'),
  label: z.string().describe('User-facing display name'),
  stageId: z.number().int().describe('Database primary key'),
  position: z.number().int().describe('0-based sort order'),
  isFixed: z.boolean().describe('True for bookends and drafting/peer_check'),
  isLocked: z.boolean().describe('True if any chapters have reached this stage or a later stage'),
});

export type WorkflowStepResponse = z.infer<typeof workflowStepResponseSchema>;

export const addWorkflowStageSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Stage name cannot be empty')
    .max(30, 'Stage names are limited to 30 characters')
    .optional()
    .default('New Stage'),
});

export const renameWorkflowStageSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, 'Stage name cannot be empty')
    .max(30, 'Stage names are limited to 30 characters'),
});

export const reorderWorkflowStagesSchema = z.object({
  stageIds: z.array(z.number().int()).min(4).describe('Ordered array of stage IDs'),
});
