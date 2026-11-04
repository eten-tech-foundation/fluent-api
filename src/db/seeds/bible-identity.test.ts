import { describe, expect, it } from 'vitest';

import type { BibleLookups, SeedBibleRow } from './bible-identity';

import { resolveBibleByIdentity } from './bible-identity';

const EXT = 'bba9f40183526463-01';
const SUFFIXED = 'BSB-bba9f4';
const identity = { abbreviation: 'BSB', name: 'Berean Standard Bible', externalId: EXT };

let nextId = 1;
function bibleRow(overrides: Partial<SeedBibleRow> = {}): SeedBibleRow {
  const id = nextId++;
  return {
    id,
    abbreviation: `B${id}`,
    name: `Bible ${id}`,
    externalId: null,
    hasAudio: false,
    audioResourceId: null,
    ...overrides,
  };
}

/** In-memory lookups over a fixed table — same semantics as the db queries. */
function lookupsOver(rows: SeedBibleRow[]): BibleLookups {
  return {
    byExternalId: async (externalId) => rows.find((r) => r.externalId === externalId),
    byAbbreviation: async (abbreviation) => rows.find((r) => r.abbreviation === abbreviation),
    byName: async (name) => rows.find((r) => r.name === name),
  };
}

describe('resolveBibleByIdentity', () => {
  it('adopts the row holding the externalId, whatever its abbreviation', async () => {
    const holder = bibleRow({ abbreviation: SUFFIXED, externalId: EXT });
    const bare = bibleRow({ abbreviation: 'BSB', externalId: 'other-01' });

    await expect(resolveBibleByIdentity(identity, lookupsOver([bare, holder]))).resolves.toEqual({
      existing: holder,
    });
  });

  it('adopts a bare-abbreviation row with no upstream identity', async () => {
    const bare = bibleRow({ abbreviation: 'BSB' });

    await expect(resolveBibleByIdentity(identity, lookupsOver([bare]))).resolves.toEqual({
      existing: bare,
    });
  });

  it('inserts at the bare abbreviation when nothing matches', async () => {
    await expect(resolveBibleByIdentity(identity, lookupsOver([]))).resolves.toEqual({
      abbreviation: 'BSB',
      name: 'Berean Standard Bible',
    });
  });

  it('inserts at the suffixed abbreviation when the bare row is a foreign identity', async () => {
    const foreign = bibleRow({ abbreviation: 'BSB', externalId: 'other-01' });

    await expect(resolveBibleByIdentity(identity, lookupsOver([foreign]))).resolves.toEqual({
      abbreviation: SUFFIXED,
      name: 'Berean Standard Bible',
    });
  });

  it('adopts a claimable row already at the suffixed abbreviation', async () => {
    const foreign = bibleRow({ abbreviation: 'BSB', externalId: 'other-01' });
    const suffixed = bibleRow({ abbreviation: SUFFIXED });

    await expect(
      resolveBibleByIdentity(identity, lookupsOver([foreign, suffixed]))
    ).resolves.toEqual({ existing: suffixed });
  });

  it('throws when the suffixed abbreviation is a second foreign identity', async () => {
    const foreign = bibleRow({ abbreviation: 'BSB', externalId: 'other-01' });
    const second = bibleRow({ abbreviation: SUFFIXED, externalId: 'other-02' });

    await expect(resolveBibleByIdentity(identity, lookupsOver([foreign, second]))).rejects.toThrow(
      /different upstream identity \(other-02\)/
    );
  });

  it('de-collides a taken name with the insert abbreviation', async () => {
    const foreign = bibleRow({
      abbreviation: 'BSB',
      name: 'Berean Standard Bible',
      externalId: 'other-01',
    });

    await expect(resolveBibleByIdentity(identity, lookupsOver([foreign]))).resolves.toEqual({
      abbreviation: SUFFIXED,
      name: `Berean Standard Bible (${SUFFIXED})`,
    });
  });

  it('throws when the de-collided name is taken too', async () => {
    const foreign = bibleRow({
      abbreviation: 'BSB',
      name: 'Berean Standard Bible',
      externalId: 'other-01',
    });
    const nameHolder = bibleRow({ name: `Berean Standard Bible (${SUFFIXED})` });

    await expect(
      resolveBibleByIdentity(identity, lookupsOver([foreign, nameHolder]))
    ).rejects.toThrow(/both taken/);
  });

  describe('without an externalId', () => {
    const local = { abbreviation: 'LOC', name: 'Local Bible' };

    it('adopts the abbreviation row whatever identity it holds', async () => {
      const row = bibleRow({ abbreviation: 'LOC', externalId: 'any-01' });

      await expect(resolveBibleByIdentity(local, lookupsOver([row]))).resolves.toEqual({
        existing: row,
      });
    });

    it('inserts at the bare abbreviation when it is free', async () => {
      await expect(resolveBibleByIdentity(local, lookupsOver([]))).resolves.toEqual({
        abbreviation: 'LOC',
        name: 'Local Bible',
      });
    });
  });
});
