import type { Result } from '@/lib/types';

import env from '@/env';
import { deleteVerseAudio } from '@/lib/audio-storage';
import { logger } from '@/lib/logger';
import { ok } from '@/lib/types';

import * as storageRepo from './storage-objects.repository';
import * as takesRepo from './verse-audio-takes.repository';

/**
 * Deletes objects nothing references any more and stamps their rows.
 *
 * Runs in two independent phases. First it drops superseded takes on settled
 * clean units: hash-keyed blobs are per-take, so without this a verse re-recorded
 * ten times would keep ten objects forever. Conflicted units are left intact
 * until resolve. That phase only deletes take rows — the objects they freed fall
 * to the orphan pass on a later sweep, which is what keeps a concurrent
 * re-upload of the same bytes from having its revived row stamped deleted.
 *
 * The orphan pass is the counterpart to the cascade: dropping a project unit
 * cascades its recordings away, but Postgres cannot touch a bucket, so without
 * this the audio would sit there forever. Runs on an interval from the server
 * entrypoint.
 */
export async function reclaimOrphanedStorageObjects(): Promise<Result<number>> {
  // Independent of the orphan pass below: a persistent failure here must not
  // starve reclamation of objects left behind by deleted project units.
  const pruned = await takesRepo.pruneSupersededTakes(env.AUDIO_TAKE_RETENTION_MS);
  if (!pruned.ok) {
    logger.error({
      message: 'Superseded take prune failed; continuing to the orphan sweep',
      context: { code: pruned.error.code },
    });
  } else if (pruned.data > 0) {
    logger.info('Pruned superseded verse audio takes', { pruned: pruned.data });
  }

  let reclaimed = 0;
  const orphans = await storageRepo.findOrphans(env.AUDIO_RECLAIM_GRACE_MS);
  if (!orphans.ok) {
    return orphans;
  }

  for (const orphan of orphans.data) {
    // The candidate list is only a hint. Lock and revalidate immediately before
    // touching the bucket so an upload cannot gain a live reference between the
    // database check and object deletion.
    const result = await storageRepo.reclaimOrphanIfUnreferenced(
      orphan.id,
      env.AUDIO_RECLAIM_GRACE_MS,
      async (locked) => deleteVerseAudio(locked.key)
    );
    if (!result.ok || !result.data) {
      continue;
    }
    reclaimed++;
  }

  if (reclaimed > 0) {
    logger.info('Reclaimed orphaned verse audio objects', { reclaimed });
  }
  return ok(reclaimed);
}
