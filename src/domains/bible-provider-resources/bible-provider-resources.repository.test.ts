import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getByIds, getByProviderIdentities } from './bible-provider-resources.repository';

const { select } = vi.hoisted(() => ({ select: vi.fn() }));

vi.mock('@/db', () => ({ db: { select } }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

describe('bible provider resource empty batches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty results without starting a table scan', async () => {
    await expect(getByIds([])).resolves.toEqual({ ok: true, data: [] });
    await expect(getByProviderIdentities([])).resolves.toEqual({ ok: true, data: [] });
    expect(select).not.toHaveBeenCalled();
  });
});
