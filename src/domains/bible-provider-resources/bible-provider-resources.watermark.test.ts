import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '@/lib/types';

import { touchLinkedBibles, updateLicenseFacts } from './bible-provider-resources.repository';

const { update, transaction } = vi.hoisted(() => {
  const update = vi.fn();
  const transaction = vi.fn();
  return { update, transaction };
});

vi.mock('@/db', () => ({ db: { update, transaction } }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function mockUpdateChain(returningValue: unknown) {
  const returning = vi.fn().mockResolvedValue(returningValue);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  update.mockReturnValue({ set });
  return { set, where, returning };
}

describe('provider-resource watermark writers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('touchLinkedBibles bumps bibles linked by audioResourceId or text identity', async () => {
    const { where, returning } = mockUpdateChain([{ id: 1 }, { id: 2 }]);

    await expect(
      touchLinkedBibles({ id: 9, provider: 'dbl', externalId: 'text-1' })
    ).resolves.toEqual({ ok: true, data: { touched: 2 } });

    expect(update).toHaveBeenCalledTimes(1);
    expect(where).toHaveBeenCalledTimes(1);
    expect(returning).toHaveBeenCalledTimes(1);
  });

  it('updateLicenseFacts rejects an empty patch', async () => {
    await expect(updateLicenseFacts(1, {})).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: ErrorCode.VALIDATION_ERROR }),
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('updateLicenseFacts updates the resource and bumps linked bibles in one transaction', async () => {
    const resource = {
      id: 9,
      provider: 'dbl' as const,
      externalId: 'text-1',
      ttsLicenseStatus: 'forbidden' as const,
      licenseNotice: null,
      displayName: null,
    };
    const resourceReturning = vi.fn().mockResolvedValue([resource]);
    const resourceWhere = vi.fn().mockReturnValue({ returning: resourceReturning });
    const resourceSet = vi.fn().mockReturnValue({ where: resourceWhere });
    const bibleReturning = vi.fn().mockResolvedValue([{ id: 1 }]);
    const bibleWhere = vi.fn().mockReturnValue({ returning: bibleReturning });
    const bibleSet = vi.fn().mockReturnValue({ where: bibleWhere });
    const txUpdate = vi
      .fn()
      .mockReturnValueOnce({ set: resourceSet })
      .mockReturnValueOnce({ set: bibleSet });

    transaction.mockImplementation(async (fn: (tx: { update: typeof txUpdate }) => unknown) =>
      fn({ update: txUpdate })
    );

    await expect(
      updateLicenseFacts(9, { ttsLicenseStatus: 'forbidden', licenseNotice: '' })
    ).resolves.toEqual({ ok: true, data: resource });

    expect(resourceSet).toHaveBeenCalledWith({
      ttsLicenseStatus: 'forbidden',
      licenseNotice: '',
    });
    expect(bibleSet).toHaveBeenCalledWith({ updatedAt: expect.anything() });
    expect(txUpdate).toHaveBeenCalledTimes(2);
  });

  it('updateLicenseFacts returns NOT_FOUND when the resource is missing', async () => {
    const resourceReturning = vi.fn().mockResolvedValue([]);
    const resourceWhere = vi.fn().mockReturnValue({ returning: resourceReturning });
    const resourceSet = vi.fn().mockReturnValue({ where: resourceWhere });
    const txUpdate = vi.fn().mockReturnValue({ set: resourceSet });
    transaction.mockImplementation(async (fn: (tx: { update: typeof txUpdate }) => unknown) =>
      fn({ update: txUpdate })
    );

    await expect(updateLicenseFacts(404, { ttsLicenseStatus: 'allowed' })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: ErrorCode.NOT_FOUND }),
    });
  });
});
