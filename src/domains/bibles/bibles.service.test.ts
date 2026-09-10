import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ok } from '@/lib/types';

import type { Bible } from './bibles.types';

import * as repo from './bibles.repository';
import { getAllBibles, getBibleById } from './bibles.service';
import { bibleResponseSchema } from './bibles.types';

vi.mock('./bibles.repository', () => ({ getAll: vi.fn(), getById: vi.fn() }));

const bible: Bible = {
  id: 1,
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageId: 1,
  provider: 'dbl',
  externalId: null,
  aquiferBibleId: 1,
  ttsLicenseStatus: 'allowed',
  licenseNotice: 'Berean Standard Bible (BSB). Public domain.',
  createdAt: null,
  updatedAt: null,
};

describe('bible licence facts', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['allowed', 'forbidden', 'unknown'] as const)(
    'publishes the curated %s status and notice, not a guess from provider',
    async (ttsLicenseStatus) => {
      vi.mocked(repo.getById).mockResolvedValue(ok({ ...bible, ttsLicenseStatus }));
      const result = await getBibleById(bible.id);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Bible lookup failed');
      expect(bibleResponseSchema.parse(result.data)).toMatchObject({
        id: 1,
        provider: 'dbl',
        ttsLicenseStatus,
        licenseNotice: bible.licenseNotice,
      });
    }
  );

  it('carries the same facts on the list and preserves a missing notice as null', async () => {
    vi.mocked(repo.getAll).mockResolvedValue(
      ok([bible, { ...bible, id: 2, ttsLicenseStatus: 'unknown', licenseNotice: null }])
    );
    const result = await getAllBibles();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Bible list failed');
    expect(result.data.map((item) => bibleResponseSchema.parse(item))).toMatchObject([
      { ttsLicenseStatus: 'allowed', licenseNotice: bible.licenseNotice },
      { ttsLicenseStatus: 'unknown', licenseNotice: null },
    ]);
  });

  it('keeps additive fields optional on the wire for existing clients', () => {
    expect(
      bibleResponseSchema.safeParse({
        id: 1,
        name: 'BSB',
        abbreviation: 'BSB',
        languageId: 1,
        provider: 'dbl',
      }).success
    ).toBe(true);
  });
});
