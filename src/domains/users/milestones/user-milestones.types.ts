import { z } from '@hono/zod-openapi';

export const userMilestoneResponseSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    projectId: z.number().int(),
    projectName: z.string(),
  })
  .openapi('UserMilestone');

export type UserMilestone = z.infer<typeof userMilestoneResponseSchema>;
