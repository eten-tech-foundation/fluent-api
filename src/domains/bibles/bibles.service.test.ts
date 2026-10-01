import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.repository';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './bibles.repository';
import { getAllBibles, getBibleById } from './bibles.service';

vi.mock('./bibles.repository', () => ({ getAll: vi.fn(), getById: vi.fn() }));
vi.mock('@/domains/bible-provider-resources/bible-provider-resources.repository', () => ({
  getById: vi.fn(),
  getByProviderIdentity: vi.fn(),
}));
const bible = {
  id: 1,
  name: 'BSB',
  abbreviation: 'BSB',
  languageId: 1,
  provider: 'dbl' as const,
  externalId: 'text-id',
  audioResourceId: 3,
  hasAudio: false,
  createdAt: null,
  updatedAt: null,
};
const recording = {
  id: 3,
  provider: 'aquifer' as const,
  externalId: '1',
  ttsLicenseStatus: 'allowed' as const,
  licenseNotice: 'Audio notice',
  displayName: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(repo.getById).mockResolvedValue(ok(bible));
  vi.mocked(resources.getById).mockResolvedValue(ok(recording));
  vi.mocked(resources.getByProviderIdentity).mockResolvedValue(ok(null));
});
describe('source bootstrap policy identity', () => {
  it.each(['allowed', 'forbidden', 'unknown'] as const)(
    'returns curated text %s independently of recording',
    async (ttsLicenseStatus) => {
      vi.mocked(resources.getByProviderIdentity).mockResolvedValue(
        ok({ ...recording, provider: 'dbl', externalId: 'text-id', ttsLicenseStatus })
      );
      const result = await getBibleById(1);
      expect(result).toMatchObject({
        ok: true,
        data: { ttsLicenseStatus, textBibleKey: 'dbl-text-id', selectedRecordingKey: 'aq-1' },
      });
      if (result.ok) expect(result.data).not.toHaveProperty('licenseNotice');
    }
  );
  it('returns unknown for missing and unidentified text rows in lists', async () => {
    vi.mocked(repo.getAll).mockResolvedValue(
      ok([bible, { ...bible, id: 2, externalId: null, audioResourceId: null }])
    );
    expect(await getAllBibles()).toMatchObject({
      ok: true,
      data: [
        { ttsLicenseStatus: 'unknown', textBibleKey: 'dbl-text-id' },
        { ttsLicenseStatus: 'unknown', textBibleKey: null, selectedRecordingKey: null },
      ],
    });
  });
  it('does not convert a database policy outage into successful unknown', async () => {
    vi.mocked(resources.getByProviderIdentity).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await getBibleById(1)).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });
});
