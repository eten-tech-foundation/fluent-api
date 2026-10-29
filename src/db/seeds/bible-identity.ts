import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { bibles } from '@/db/schema';

import { suffixedAbbreviation } from './reference-bibles';

export interface SeedBibleRow {
  id: number;
  abbreviation: string;
  externalId: string | null;
  hasAudio: boolean;
  audioResourceId: number | null;
}

const columns = {
  id: bibles.id,
  abbreviation: bibles.abbreviation,
  externalId: bibles.externalId,
  hasAudio: bibles.hasAudio,
  audioResourceId: bibles.audioResourceId,
};

async function byAbbreviation(abbreviation: string): Promise<SeedBibleRow | undefined> {
  const [row] = await db
    .select(columns)
    .from(bibles)
    .where(eq(bibles.abbreviation, abbreviation))
    .limit(1);
  return row;
}

/**
 * Resolves the bible row a seed should own, shared by seeds/bibles.ts and the
 * demo engine so both converge on the same row.
 *
 * (provider, externalId) is the canonical upstream identity — a catalogue sync
 * may already own it under a different abbreviation (e.g. QA's 'BSB-bba9f4'),
 * and stamping the same external_id on a second row violates
 * idx_bibles_provider_external_id. Resolution order:
 *   1. the row holding `externalId` → adopt it;
 *   2. the bare-abbreviation row, unless it claims a *different* upstream
 *      identity → adopt it (the caller claims `externalId` onto it);
 *   3. otherwise the catalogue sync's suffixed abbreviation — adopt a row
 *      there under the same rule, else return it as the insert target.
 *
 * Returns either the row to reconcile or the abbreviation to insert under.
 * Throws only on a genuine second collision (the suffixed slot is held by yet
 * another upstream identity).
 */
export async function resolveBibleByIdentity(identity: {
  abbreviation: string;
  externalId?: string;
}): Promise<{ existing: SeedBibleRow } | { existing?: undefined; abbreviation: string }> {
  const { abbreviation, externalId } = identity;
  if (!externalId) {
    const bare = await byAbbreviation(abbreviation);
    return bare ? { existing: bare } : { abbreviation };
  }

  const [holder] = await db
    .select(columns)
    .from(bibles)
    .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, externalId)))
    .limit(1);
  if (holder) return { existing: holder };

  const claimable = (row: SeedBibleRow) => row.externalId === null || row.externalId === externalId;

  const bare = await byAbbreviation(abbreviation);
  if (!bare) return { abbreviation };
  if (claimable(bare)) return { existing: bare };

  const suffixed = suffixedAbbreviation(abbreviation, externalId);
  const taken = await byAbbreviation(suffixed);
  if (!taken) return { abbreviation: suffixed };
  if (claimable(taken)) return { existing: taken };
  throw new Error(
    `Bible "${suffixed}" holds a different upstream identity ` +
      `(${taken.externalId}) — reconcile it manually before seeding.`
  );
}
