import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { bibles } from '@/db/schema';

import { suffixedAbbreviation } from './reference-bibles';

export interface SeedBibleRow {
  id: number;
  abbreviation: string;
  name: string;
  externalId: string | null;
  hasAudio: boolean;
  audioResourceId: number | null;
}

/** The three point lookups resolution needs — injectable so the branch table is unit-testable. */
export interface BibleLookups {
  byExternalId: (externalId: string) => Promise<SeedBibleRow | undefined>;
  byAbbreviation: (abbreviation: string) => Promise<SeedBibleRow | undefined>;
  byName: (name: string) => Promise<SeedBibleRow | undefined>;
}

const columns = {
  id: bibles.id,
  abbreviation: bibles.abbreviation,
  name: bibles.name,
  externalId: bibles.externalId,
  hasAudio: bibles.hasAudio,
  audioResourceId: bibles.audioResourceId,
};

const dbLookups: BibleLookups = {
  async byExternalId(externalId) {
    const [row] = await db
      .select(columns)
      .from(bibles)
      .where(and(eq(bibles.provider, 'dbl'), eq(bibles.externalId, externalId)))
      .limit(1);
    return row;
  },
  async byAbbreviation(abbreviation) {
    const [row] = await db
      .select(columns)
      .from(bibles)
      .where(eq(bibles.abbreviation, abbreviation))
      .limit(1);
    return row;
  },
  async byName(name) {
    const [row] = await db.select(columns).from(bibles).where(eq(bibles.name, name)).limit(1);
    return row;
  },
};

export type BibleResolution =
  { existing: SeedBibleRow } | { existing?: undefined; abbreviation: string; name: string };

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
 * Returns either the row to reconcile or the abbreviation + name to insert
 * under. `bibles.name` is unique too, so a name held by another row gets the
 * sync's `${name} (${abbreviation})` form (dbl-bible-sync.ts). Throws only on a
 * genuine second collision (suffixed slot or de-collided name also taken).
 */
export async function resolveBibleByIdentity(
  identity: { abbreviation: string; name: string; externalId?: string },
  lookups: BibleLookups = dbLookups
): Promise<BibleResolution> {
  const { abbreviation, name, externalId } = identity;

  const insertAt = async (target: string): Promise<BibleResolution> => {
    if (!(await lookups.byName(name))) return { abbreviation: target, name };
    const decollided = `${name} (${target})`;
    if (await lookups.byName(decollided)) {
      throw new Error(
        `Bible names "${name}" and "${decollided}" are both taken — ` +
          'reconcile them manually before seeding.'
      );
    }
    return { abbreviation: target, name: decollided };
  };

  if (!externalId) {
    const bare = await lookups.byAbbreviation(abbreviation);
    return bare ? { existing: bare } : insertAt(abbreviation);
  }

  const holder = await lookups.byExternalId(externalId);
  if (holder) return { existing: holder };

  const claimable = (row: SeedBibleRow) => row.externalId === null || row.externalId === externalId;

  const bare = await lookups.byAbbreviation(abbreviation);
  if (!bare) return insertAt(abbreviation);
  if (claimable(bare)) return { existing: bare };

  const suffixed = suffixedAbbreviation(abbreviation, externalId);
  const taken = await lookups.byAbbreviation(suffixed);
  if (!taken) return insertAt(suffixed);
  if (claimable(taken)) return { existing: taken };
  throw new Error(
    `Bible "${suffixed}" holds a different upstream identity ` +
      `(${taken.externalId}) — reconcile it manually before seeding.`
  );
}
