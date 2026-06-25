import { z } from '@hono/zod-openapi';

import { userSettingsSchema } from '@/db/schema';

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

// `settings` advertises the real `userSettingsSchema` shape (the allowed keys and
// their enum values) rather than a generic object: the service's `toResponse`
// already normalizes every stored blob through `userSettingsSchema` on read, so
// the response body provably conforms to it — the spec should say so. Nullable for
// a user with no row yet (mirrors editor-state — not a 404). (We intentionally do
// NOT tighten the *request* schema; see the boundary-vs-service note above.)
export const userSettingsResponseSchema = z
  .object({
    settings: userSettingsSchema.nullable(),
    updatedAt: z.string().nullable(),
  })
  .openapi('UserSettingsResponse');

export type UserSettingsResponse = z.infer<typeof userSettingsResponseSchema>;
