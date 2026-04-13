import { z } from '@hono/zod-openapi';

import type { insertUsersSchema, patchUsersSchema, selectUsersSchema } from '@/db/schema';

// ─── DB-derived types ─────────────────────────────────────────────────────────

export type User = z.infer<typeof selectUsersSchema>;
export type CreateUserInput = z.infer<typeof insertUsersSchema>;
export type UpdateUserInput = z.infer<typeof patchUsersSchema>;

// Used by findByEmail — joined with roles table to support policy checks
export type UserWithRole = User & { roleName: string };

// ─── API response schema ──────────────────────────────────────────────────────

export const userResponseSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  username: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  role: z.number().int(),
  organization: z.number().int(),
  createdBy: z.number().int().nullable(),
  status: z.enum(['invited', 'verified', 'inactive']),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export const createUserRequestSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.string().email().max(255),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  role: z.number().int(),
  // Note: 'organization' is intentionally omitted here so clients cannot spoof it.
  // It will be injected by the route handler.
  status: z.enum(['invited', 'verified', 'inactive']).default('invited'),
});

export const updateUserRequestSchema = z.object({
  username: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),
  role: z.number().int().optional(),
  status: z.enum(['invited', 'verified', 'inactive']).optional(),
  // 'organization' is omitted to prevent cross-tenant transfers.
});

// Const enumerations

export const USER_ACTIONS = {
  LIST: 'list',
  CREATE: 'create',
  VIEW: 'view',
  UPDATE: 'update',
  DELETE: 'delete',
} as const;

export type UserAction = (typeof USER_ACTIONS)[keyof typeof USER_ACTIONS];
