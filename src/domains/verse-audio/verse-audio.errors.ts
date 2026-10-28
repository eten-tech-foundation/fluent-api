import type { Result } from '@/lib/types';

import { getPostgresConstraintName } from '@/lib/db-errors';
import { err, ErrorCode } from '@/lib/types';

/** Storage-object FKs that fail when reclaim races an insert/promotion. */
const RETRYABLE_STORAGE_FK_CONSTRAINTS = new Set([
  'verse_audio_takes_storage_object_id_storage_objects_id_fk',
  'verse_audio_recordings_storage_object_id_storage_objects_id_fk',
  'verse_audio_recordings_active_take_id_verse_audio_takes_id_fk',
]);

export function mapForeignKeyViolation(error: unknown): Result<never> {
  const constraint = getPostgresConstraintName(error) ?? '';
  if (RETRYABLE_STORAGE_FK_CONSTRAINTS.has(constraint) || constraint.includes('storage_object')) {
    // Reclamation / prune deleted the referenced row; safe to reload and retry.
    return err(ErrorCode.VERSE_AUDIO_VERSION_CONFLICT);
  }
  if (constraint.includes('recording_id')) {
    return err(ErrorCode.VERSE_AUDIO_NOT_FOUND);
  }
  return err(ErrorCode.INTERNAL_ERROR);
}
