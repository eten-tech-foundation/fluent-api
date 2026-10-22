import { userSettingsSchema, userSettingsWriteSchema } from '@/db/schema';
import { err, ErrorCode, ok } from '@/lib/types';

import type { UserSettingsPatch, UserSettingsResponse } from './self-settings.types';

import * as repo from './self-settings.repository';
import { SETTINGS_CAPABILITIES } from './self-settings.types';

function toResponse(row: repo.UserSettingsRow | null): UserSettingsResponse {
  if (!row) {
    return {
      settings: null,
      updatedAt: null,
      settingsCapabilities: SETTINGS_CAPABILITIES,
    };
  }
  return {
    // Normalize the stored JSONB blob through the tolerant read schema
    // (`userSettingsSchema = userSettingsObjectSchema.catch({})`). The `jsonb`
    // column accepts any JSON and Drizzle's `.$type<>()` is compile-time only, so
    // a malformed/legacy stored blob must be re-validated on read — `.catch({})`
    // degrades an unparseable shape to `{}` instead of leaking it (W8). A genuine
    // `null` (no settings yet) is preserved: parsing `null` would yield `{}`,
    // which would break the "settings: null when no row" contract. Deleted keys
    // are omitted by the atomic SQL strip — never echoed as JSON null.
    settings: row.settings == null ? null : userSettingsSchema.parse(row.settings),
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    settingsCapabilities: SETTINGS_CAPABILITIES,
  };
}

function isEmptyPatch(patch: UserSettingsPatch): boolean {
  return Object.keys(patch).length === 0;
}

export async function getSettings(userId: number) {
  const result = await repo.findByUser(userId);
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}

export async function upsertSettings(userId: number, rawSettings: unknown) {
  // Validate the incoming write with the STRICT schema (no `.catch`), so a
  // malformed body is rejected (as a 422 — see below) rather than silently
  // swallowed. Unknown top-level keys are stripped; bad shapes for known keys
  // fail parsing. Explicit `null` deletes only `displayMode`;
  // `checkIgnoredWordPairs: null` is a 422. Absent keys are omitted from the
  // patch (untouched). (The `.catch({})` W8 tolerance applies only when reading
  // stored rows back.)
  const parsed = userSettingsWriteSchema.safeParse(rawSettings);
  // A malformed body is a request-shape (validation) failure, not a reference
  // error — VALIDATION_ERROR maps to 422, the correct status for a well-formed
  // request whose contents fail schema validation.
  if (!parsed.success) return err(ErrorCode.VALIDATION_ERROR);

  const patch = parsed.data;

  // Empty after unknown-key strip (including `PUT { settings: {} }`) is a no-op:
  // do not erase the blob or bump updatedAt.
  if (isEmptyPatch(patch)) {
    const existing = await repo.findByUser(userId);
    if (!existing.ok) return existing;
    return ok(toResponse(existing.data));
  }

  const result = await repo.mergePatch({ userId, patch });
  if (!result.ok) return result;
  return ok(toResponse(result.data));
}
