import { z } from '@hono/zod-openapi';

import type { insertUsersSchema, patchUsersSchema, selectUsersSchema } from '@/db/schema';

// ─── DB-derived types ─────────────────────────────────────────────────────────

export type User = z.infer<typeof selectUsersSchema>;
export type CreateUserInput = z.infer<typeof insertUsersSchema>;
export type UpdateUserInput = z.infer<typeof patchUsersSchema>;

export type CreateUserWithAuthInput = CreateUserInput & { authUserId: string };

// Used by findByEmail — dropped roleName
export type UserWithRole = User;

// ─── API response schema ──────────────────────────────────────────────────────

export const userResponseSchema = z.object({
  id: z.number().int(),
  email: z.string().email(),
  username: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),

  createdBy: z.number().int().nullable(),
  status: z.enum(['invited', 'verified', 'inactive']),
  createdAt: z.date().nullable(),
  updatedAt: z.date().nullable(),
  orgGrants: z
    .array(
      z.object({
        roleId: z.number().int(),
        roleName: z.string(),
        orgId: z.number().int().nullable(),
        projectId: z.number().int().nullable(),
        orgName: z.string().nullable().optional(),
      })
    )
    .optional(),
  lastActiveOrgId: z.number().int().nullable().optional(),
});

export type UserResponse = z.infer<typeof userResponseSchema>;

export const createUserRequestSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.string().email().max(255),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  status: z.enum(['invited', 'verified', 'inactive']).default('invited'),
  // Grant fields — where and what role to assign the new user
  orgId: z.number().int(),
  projectId: z.number().int().optional().nullable(),
  roleName: z.string().optional(),
});

export const inviteUserRequestSchema = z.object({
  username: z.string().min(1).max(100),
  email: z.string().email().max(255),
  orgId: z.number().int(),
  projectId: z.number().int().optional().nullable(),
  roleName: z.string().optional(),
  orgName: z.string().optional(),
  inviterName: z.string().optional(),
});

export const updateUserRequestSchema = z.object({
  username: z.string().min(1).max(100).optional(),
  email: z.string().email().max(255).optional(),
  firstName: z.string().max(100).optional().nullable(),
  lastName: z.string().max(100).optional().nullable(),

  status: z.enum(['invited', 'verified', 'inactive']).optional(),
  lastActiveOrgId: z.number().int().nullable().optional(),
  // 'organization' is omitted to prevent cross-tenant transfers.
});

export const updateActiveOrgRequestSchema = z.object({
  orgId: z.number().int(),
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
