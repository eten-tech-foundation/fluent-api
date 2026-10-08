import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAll } from './books.repository';

const { mockDb } = vi.hoisted(() => {
  const mockDb = { select: vi.fn() };
  return { mockDb };
});

vi.mock('@/db', () => ({ db: mockDb }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('books.getAll', () => {
  it('returns all books without a where clause when updatedAfter is omitted', async () => {
    const rows = [{ id: 1, code: 'GEN', eng_display_name: 'Genesis' }];
    const fromFn = vi.fn().mockResolvedValue(rows);
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll();

    expect(result).toEqual({ ok: true, data: rows });
    expect(fromFn).toHaveBeenCalled();
  });

  it('applies updatedAfter filter via where when provided', async () => {
    const rows: unknown[] = [];
    const whereFn = vi.fn().mockResolvedValue(rows);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await getAll(new Date('2025-06-01T12:00:00.000Z'));

    expect(result).toEqual({ ok: true, data: [] });
    expect(whereFn).toHaveBeenCalledOnce();
  });
});
