import { z } from '@hono/zod-openapi';

export const projectUserResponseSchema = z.object({
  projectId: z.number().int(),
  userId: z.number().int(),
  displayName: z.string(),
  roleID: z.number().int(),
  createdAt: z.union([z.date(), z.string()]).nullable(),
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

export const removeProjectUserParamSchema = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectId', in: 'path', required: true },
    }),
  userId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'userId', in: 'path', required: true },
    }),
});

export const addProjectUserSchema = z.object({
  userIds: z.array(z.number().int().positive()).min(1, 'At least one user ID is required'),
});

// Domain types inferred from zod

export type ProjectUserRecord = z.infer<typeof projectUserResponseSchema>;
export type AddProjectUserInput = z.infer<typeof addProjectUserSchema>;
