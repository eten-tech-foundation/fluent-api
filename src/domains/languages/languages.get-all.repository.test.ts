import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAll } from './languages.repository';

const { mockDb } = vi.hoisted(() => {
  const mockDb = { select: vi.fn() };
  return { mockDb };
});

vi.mock('@/db', () => ({ db: mockDb }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('languages.getAll', () => {
  it('returns all languages without a where clause when updatedAfter is omitted', async () => {
    const rows = [{ id: 1, langName: 'English' }];
    const fromFn = vi.fn().mockResolvedValue(rows);
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll();

    expect(result).toEqual({ ok: true, data: rows });
    expect(fromFn).toHaveBeenCalled();
    expect(fromFn).toHaveBeenCalledWith(expect.anything());
  });

  it('applies updatedAfter filter via where when provided', async () => {
    const rows: unknown[] = [];
    const whereFn = vi.fn().mockResolvedValue(rows);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockDb.select.mockReturnValue({ from: fromFn });

    const updatedAfter = new Date('2025-01-01T00:00:00.000Z');
    const result = await getAll(updatedAfter);

    expect(result).toEqual({ ok: true, data: [] });
    expect(whereFn).toHaveBeenCalledOnce();
  });
});
