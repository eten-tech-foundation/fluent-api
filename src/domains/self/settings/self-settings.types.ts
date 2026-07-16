import { z } from '@hono/zod-openapi';

import type { userSettingsSchema } from '@/db/schema';

import { userSettingsObjectSchema } from '@/db/schema';

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

// `settings` advertises the real settings shape (the allowed keys and their enum
// values) rather than a generic object: the service's `toResponse` already
// normalizes every stored blob through `userSettingsSchema` on read, so the
// response body provably conforms to it — the spec should say so. Nullable for a
// user with no row yet (mirrors editor-state — not a 404). (We intentionally do
// NOT tighten the *request* schema; see the boundary-vs-service note above.)
//
// We embed the PLAIN `userSettingsObjectSchema`, NOT the `.catch({})` read schema
// (`userSettingsSchema`): the `.catch` wrapper is a `ZodCatch` that
// zod-to-openapi can't render (it 500s `/doc` — see the note in db/schema.ts and
// the guard in src/routes/doc.route.test.ts). The two schemas describe the same
// fields, so the documented shape is unchanged; the fail-soft `.catch` tolerance
// lives entirely in the service read path (`toResponse`), which is where it
// belongs — it was never meant to be part of the published contract.
export const userSettingsResponseSchema = z
  .object({
    settings: userSettingsObjectSchema.nullable(),
    updatedAt: z.string().nullable(),
  })
  .openapi('UserSettingsResponse');

export type UserSettingsResponse = z.infer<typeof userSettingsResponseSchema>;
