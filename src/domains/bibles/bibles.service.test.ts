import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './bibles.repository';
import {
  createBible,
  getAllBibles,
  getBibleById,
  getBiblesByLanguageId,
  updateBible,
} from './bibles.service';

vi.mock('./bibles.repository', () => ({
  getAll: vi.fn(),
  getById: vi.fn(),
  getByLanguageId: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock('@/domains/bible-provider-resources/bible-provider-resources.service', () => ({
  getById: vi.fn(),
  getByProviderIdentity: vi.fn(),
  getByIds: vi.fn(),
  getByProviderIdentities: vi.fn(),
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
  vi.mocked(repo.create).mockResolvedValue(ok(bible));
  vi.mocked(repo.update).mockResolvedValue(ok(bible));
  vi.mocked(resources.getById).mockResolvedValue(ok(recording));
  vi.mocked(resources.getByProviderIdentity).mockResolvedValue(ok(null));
  vi.mocked(resources.getByIds).mockResolvedValue(ok([]));
  vi.mocked(resources.getByProviderIdentities).mockResolvedValue(ok([]));
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
      expect(resources.getByProviderIdentities).not.toHaveBeenCalled();
      expect(resources.getByIds).not.toHaveBeenCalled();
    }
  );

  it('returns unknown when a single text identity is missing', async () => {
    expect(await getBibleById(1)).toMatchObject({
      ok: true,
      data: { ttsLicenseStatus: 'unknown', textBibleKey: 'dbl-text-id' },
    });
  });

  it('does not convert a single-resource database outage into successful unknown', async () => {
    vi.mocked(resources.getByProviderIdentity).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await getBibleById(1)).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });

  it.each([
    ['create', () => createBible(bible)],
    ['update', () => updateBible(1, bible)],
  ])('keeps %s enrichment on bounded single-resource lookups', async (_label, write) => {
    await expect(write()).resolves.toMatchObject({ ok: true, data: { id: 1 } });
    expect(resources.getByProviderIdentity).toHaveBeenCalledTimes(1);
    expect(resources.getById).toHaveBeenCalledTimes(1);
    expect(resources.getByProviderIdentities).not.toHaveBeenCalled();
    expect(resources.getByIds).not.toHaveBeenCalled();
  });
});

describe('batched list enrichment', () => {
  const repeated = { ...bible, id: 2, name: 'BSB copy', abbreviation: 'BSB2' };
  const missing = {
    ...bible,
    id: 3,
    name: 'WEB',
    abbreviation: 'WEB',
    externalId: 'missing-text',
    audioResourceId: 99,
  };
  const unidentified = {
    ...bible,
    id: 4,
    name: 'Local',
    abbreviation: 'LOC',
    externalId: null,
    audioResourceId: null,
  };
  const other = {
    ...bible,
    id: 5,
    name: 'Other',
    abbreviation: 'OTH',
    externalId: 'other-text',
    audioResourceId: 4,
  };
  const rows = [repeated, missing, other, bible, unidentified];
  const textResource = {
    ...recording,
    id: 8,
    provider: 'dbl' as const,
    externalId: 'text-id',
    ttsLicenseStatus: 'forbidden' as const,
  };
  const otherTextResource = {
    ...textResource,
    id: 9,
    externalId: 'other-text',
    ttsLicenseStatus: 'allowed' as const,
  };
  const otherRecording = {
    ...recording,
    id: 4,
    provider: 'youversion' as const,
    externalId: '88',
  };

  beforeEach(() => {
    vi.mocked(repo.getAll).mockResolvedValue(ok(rows));
    vi.mocked(repo.getByLanguageId).mockResolvedValue(ok(rows));
    // Deliberately return rows in a different order than the Bible list.
    vi.mocked(resources.getByProviderIdentities).mockResolvedValue(
      ok([otherTextResource, textResource])
    );
    vi.mocked(resources.getByIds).mockResolvedValue(ok([otherRecording, recording]));
  });

  it.each([
    ['all Bibles', () => getAllBibles()],
    ['Bibles by language', () => getBiblesByLanguageId(1)],
  ])('deduplicates lookups and preserves response order for %s', async (_label, list) => {
    const result = await list();

    expect(result).toMatchObject({
      ok: true,
      data: [
        { id: 2, ttsLicenseStatus: 'forbidden', selectedRecordingKey: 'aq-1' },
        {
          id: 3,
          ttsLicenseStatus: 'unknown',
          textBibleKey: 'dbl-missing-text',
          selectedRecordingKey: null,
        },
        {
          id: 5,
          ttsLicenseStatus: 'allowed',
          textBibleKey: 'dbl-other-text',
          selectedRecordingKey: 'yv-88',
        },
        { id: 1, ttsLicenseStatus: 'forbidden', selectedRecordingKey: 'aq-1' },
        {
          id: 4,
          ttsLicenseStatus: 'unknown',
          textBibleKey: null,
          selectedRecordingKey: null,
        },
      ],
    });
    expect(resources.getByProviderIdentities).toHaveBeenCalledTimes(1);
    expect(resources.getByProviderIdentities).toHaveBeenCalledWith([
      { provider: 'dbl', externalId: 'text-id' },
      { provider: 'dbl', externalId: 'missing-text' },
      { provider: 'dbl', externalId: 'other-text' },
    ]);
    expect(resources.getByIds).toHaveBeenCalledTimes(1);
    expect(resources.getByIds).toHaveBeenCalledWith([3, 99, 4]);
    expect(resources.getByProviderIdentity).not.toHaveBeenCalled();
    expect(resources.getById).not.toHaveBeenCalled();
  });

  it('handles an empty list without single-record enrichment', async () => {
    vi.mocked(repo.getAll).mockResolvedValue(ok([]));

    expect(await getAllBibles()).toEqual(ok([]));
    expect(resources.getByProviderIdentities).toHaveBeenCalledWith([]);
    expect(resources.getByIds).toHaveBeenCalledWith([]);
    expect(resources.getByProviderIdentity).not.toHaveBeenCalled();
    expect(resources.getById).not.toHaveBeenCalled();
  });

  it.each(['text', 'recording'] as const)('propagates a %s batch failure', async (kind) => {
    if (kind === 'text')
      vi.mocked(resources.getByProviderIdentities).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    else vi.mocked(resources.getByIds).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    expect(await getAllBibles()).toEqual(err(ErrorCode.INTERNAL_ERROR));
  });
});
