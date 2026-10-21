import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getAll, searchSourceBibles } from './bibles.repository';

const { mockDb } = vi.hoisted(() => {
  const mockDb = { select: vi.fn() };
  return { mockDb };
});

vi.mock('@/db', () => ({ db: mockDb }));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('bibles.getAll', () => {
  it('returns all bibles without a where clause when updatedAfter is omitted', async () => {
    const rows = [{ id: 1, name: 'ESV', abbreviation: 'ESV', languageId: 1 }];
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

    const result = await getAll(new Date('2025-01-01T00:00:00.000Z'));

    expect(result).toEqual({ ok: true, data: [] });
    expect(whereFn).toHaveBeenCalledOnce();
  });
});

describe('searchSourceBibles', () => {
  it('returns grouped languages and bibles matching the search query', async () => {
    const fakeRows = [
      {
        bibleId: 1,
        bibleName: 'Indian Revised Version Gujarati',
        bibleAbbreviation: 'IRV-GUJ',
        bibleProvider: 'dbl',
        languageId: 10,
        langName: 'Gujarati',
        langCodeIso6393: 'guj',
      },
    ];

    const limitFn = vi.fn().mockResolvedValue(fakeRows);
    const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
    const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
    mockDb.select.mockReturnValue({ from: fromFn });

    const result = await searchSourceBibles('guj');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.languages).toHaveLength(1);
      expect(result.data.languages[0]).toEqual({
        id: 10,
        langName: 'Gujarati',
        langCodeIso6393: 'guj',
        bibleCount: 1,
        bibles: [
          {
            id: 1,
            name: 'Indian Revised Version Gujarati',
            abbreviation: 'IRV-GUJ',
            provider: 'dbl',
          },
        ],
      });
      expect(result.data.bibles).toHaveLength(1);
      expect(result.data.bibles[0]).toEqual({
        id: 1,
        name: 'Indian Revised Version Gujarati',
        abbreviation: 'IRV-GUJ',
        provider: 'dbl',
        languageId: 10,
        languageName: 'Gujarati',
        languageCode: 'guj',
      });
    }
  });
});
