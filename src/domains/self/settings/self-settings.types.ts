import { z } from '@hono/zod-openapi';

import type { userSettingsSchema } from '@/db/schema';

// ─── DB-derived types ─────────────────────────────────────────────────────────

export type UserSettings = z.infer<typeof userSettingsSchema>;

export interface UpsertUserSettingsInput {
  userId: number;
  settings: UserSettings;
}

// ─── API request schema ───────────────────────────────────────────────────────

// The blob is validated against `userSettingsSchema` in the service layer (so a
// schema violation yields a 400). At the route boundary we accept any object so
// the OpenAPI surface documents `{ settings: {...} }` without duplicating the
// per-key rules.
export const saveUserSettingsRequestSchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
  })
  .openapi('UserSettingsInput');

export type SaveUserSettingsRequest = z.infer<typeof saveUserSettingsRequestSchema>;

// ─── API response schema ──────────────────────────────────────────────────────

// `settings: null` for a user with no row yet (mirrors editor-state — not a 404).
export const userSettingsResponseSchema = z
  .object({
    settings: z.record(z.string(), z.unknown()).nullable(),
    updatedAt: z.string().nullable(),
  })
  .openapi('UserSettingsResponse');

export type UserSettingsResponse = z.infer<typeof userSettingsResponseSchema>;
