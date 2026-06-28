import { userSettingsSchema, userSettingsWriteSchema } from '@/db/schema';
import { err, ErrorCode, ok } from '@/lib/types';

import type { UserSettings, UserSettingsResponse } from './self-settings.types';

import * as repo from './self-settings.repository';

function toResponse(row: repo.UserSettingsRow | null): UserSettingsResponse {
  if (!row) return { settings: null, updatedAt: null };
  return {
    // Normalize the stored JSONB blob through the tolerant read schema
    // (`userSettingsSchema = userSettingsObjectSchema.catch({})`). The `jsonb`
    // column accepts any JSON and Drizzle's `.$type<>()` is compile-time only, so
    // a malformed/legacy stored blob must be re-validated on read — `.catch({})`
    // degrades an unparseable shape to `{}` instead of leaking it (W8). A genuine
    // `null` (no settings yet) is preserved: parsing `null` would yield `{}`,
    // which would break the "settings: null when no row" contract.
    settings: row.settings == null ? null : userSettingsSchema.parse(row.settings),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

export async function getSettings(userId: number) {
  const result = await repo.findByUser(userId);
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}

export async function upsertSettings(userId: number, rawSettings: unknown) {
  // Validate the incoming write with the STRICT schema (no `.catch`), so a
  // malformed body is rejected as a 400 rather than silently swallowed. Unknown
  // top-level keys are stripped; bad shapes for known keys fail parsing. (The
  // `.catch({})` W8 tolerance applies only when reading stored rows back.)
  const parsed = userSettingsWriteSchema.safeParse(rawSettings);
  if (!parsed.success) return err(ErrorCode.INVALID_REFERENCE);

  const settings: UserSettings = parsed.data;

  // ⚠️ FULL-REPLACE — intentional WHILE there is a single settings key ⚠️
  // `repo.upsert` overwrites the whole `settings` JSONB blob (no server-side
  // merge). The client GETs, edits its one key, and PUTs the whole blob back
  // (last-writer-wins; §8.1/§8.3). This is safe ONLY because `userSettings*`
  // currently has exactly one key (`checkIgnoredWordPairs`) — see the gate note
  // on `userSettingsObjectSchema` in `db/schema.ts`. BEFORE a second key is
  // added there, this function MUST read-merge-write instead: load the existing
  // blob, shallow-merge the incoming keys over it (an explicit `null` value
  // deletes that key; absent keys stay untouched), then persist — otherwise this
  // full-replace silently drops whatever key the caller didn't send.
  const result = await repo.upsert({ userId, settings });
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}
