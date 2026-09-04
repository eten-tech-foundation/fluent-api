import { beforeEach, describe, expect, it, vi } from 'vitest';

import { searchSourceBibles } from './bibles.repository';

const { mockDb } = vi.hoisted(() => {
  const mockDb = { select: vi.fn() };
  return { mockDb };
});

vi.mock('@/db', () => ({ db: mockDb }));

beforeEach(() => {
  vi.clearAllMocks();
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
    const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
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
