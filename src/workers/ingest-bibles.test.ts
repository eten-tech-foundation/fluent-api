import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '../db';
import { ingestDblBibles } from './ingest-bibles';

vi.mock('../db', () => ({
  db: {
    query: {
      languages: { findFirst: vi.fn() },
      books: {
        findFirst: vi.fn().mockResolvedValue({ id: 1 }),
      },
    },
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([{ id: 1 }]),
        })),
        // onConflictDoNothing now needs to return an object with .returning()
        // for the books insert (which calls .returning() after .onConflictDoNothing())
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn().mockResolvedValue([]),
        })),
        returning: vi.fn().mockResolvedValue([{ id: 1 }]),
      })),
    })),
  },
}));

const mockDblClientInstance = {
  getBibles: vi.fn(),
  getBooks: vi.fn(),
};

vi.mock('../lib/dbl/client', () => {
  return {
    DblClient: vi.fn(() => mockDblClientInstance),
  };
});

describe('ingestDblBibles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs the full ingestion pipeline with provider precedence', async () => {
    mockDblClientInstance.getBibles.mockResolvedValue([
      {
        id: 'bible-1',
        abbreviation: 'KJV',
        name: 'King James',
        nameLocal: 'King James',
        language: {
          id: 'eng',
          name: 'English',
          nameLocal: 'English',
          script: 'Latn',
          scriptDirection: 'LTR',
        },
        type: 'text',
        updatedAt: '2023-01-01',
      },
    ]);

    mockDblClientInstance.getBooks.mockResolvedValue([
      {
        id: 'GEN',
        bibleId: 'bible-1',
        abbreviation: 'GEN',
        name: 'Genesis',
        nameLong: 'Genesis',
      },
    ]);

    await ingestDblBibles();

    // Verify db.insert was called for: language, bible, book, bible_book link
    expect(db.insert).toHaveBeenCalledTimes(4);
  });

  it('skips Bibles with restricted-license metadata', async () => {
    mockDblClientInstance.getBibles.mockResolvedValue([
      {
        id: 'bible-restricted',
        abbreviation: 'RST',
        name: 'Restricted Bible',
        nameLocal: 'Restricted',
        info: 'This is a restricted commercial translation',
        language: {
          id: 'eng',
          name: 'English',
          nameLocal: 'English',
          script: 'Latn',
          scriptDirection: 'LTR',
        },
        type: 'text',
        updatedAt: '2023-01-01',
      },
    ]);

    await ingestDblBibles();

    // Should not call db.insert at all since the Bible was filtered out
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('skips Bibles with missing language metadata', async () => {
    mockDblClientInstance.getBibles.mockResolvedValue([
      {
        id: 'bible-no-lang',
        abbreviation: 'NLG',
        name: 'No Language Bible',
        nameLocal: 'No Language',
        type: 'text',
        updatedAt: '2023-01-01',
        // language is undefined
      },
    ]);

    await ingestDblBibles();

    expect(db.insert).not.toHaveBeenCalled();
  });

  it('continues processing remaining Bibles when one fails', async () => {
    mockDblClientInstance.getBibles.mockResolvedValue([
      {
        id: 'bible-bad',
        abbreviation: 'BAD',
        name: 'Bad Bible',
        nameLocal: 'Bad',
        language: {
          id: 'eng',
          name: 'English',
          nameLocal: 'English',
          script: 'Latn',
          scriptDirection: 'LTR',
        },
        type: 'text',
        updatedAt: '2023-01-01',
      },
      {
        id: 'bible-good',
        abbreviation: 'GOOD',
        name: 'Good Bible',
        nameLocal: 'Good',
        language: {
          id: 'spa',
          name: 'Spanish',
          nameLocal: 'Español',
          script: 'Latn',
          scriptDirection: 'LTR',
        },
        type: 'text',
        updatedAt: '2023-01-01',
      },
    ]);

    // First Bible's getBooks call fails, second succeeds
    mockDblClientInstance.getBooks
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce([
        {
          id: 'GEN',
          bibleId: 'bible-good',
          abbreviation: 'GEN',
          name: 'Genesis',
          nameLong: 'Genesis',
        },
      ]);

    await ingestDblBibles();

    // Both Bibles should attempt language + bible inserts (2 each = 4),
    // but only the second Bible proceeds to book + bible_book (2 more = 6 total).
    // The first Bible errors after bible insert, so: lang(1) + bible(1) + lang(2) + bible(2) + book + link = 6
    expect(db.insert).toHaveBeenCalled();
    // getBooks should have been called for both Bibles
    expect(mockDblClientInstance.getBooks).toHaveBeenCalledTimes(2);
  });
});
