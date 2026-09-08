import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@/lib/types';

import { getContent } from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

function transactionWithVerses(rows: Array<Record<string, unknown>>): DbTransaction {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);

  return {
    select: vi.fn((selection: Record<string, unknown>) => {
      chain.orderBy = vi.fn().mockResolvedValue(
        rows.map((row) =>
          Object.fromEntries(
            Object.keys(selection)
              .filter((key) => key in row)
              .map((key) => [key, row[key]])
          )
        )
      );
      return chain;
    }),
  } as unknown as DbTransaction;
}

describe('chapter-assignments.repository getContent', () => {
  it('keeps a stored mid-chapter heading outside the following verse when no paragraph was stored', async () => {
    const tx = transactionWithVerses([
      {
        id: 1,
        content: 'First.',
        verseNumber: 1,
        bibleTextId: 101,
        bookCode: 'GEN',
        bookName: 'Genesis',
        markers: null,
      },
      {
        id: 2,
        content: 'Second.',
        verseNumber: 2,
        bibleTextId: 102,
        bookCode: 'GEN',
        bookName: 'Genesis',
        markers: { headings: [{ marker: 's1', text: 'The Creation' }] },
      },
    ]);

    const result = await getContent(tx, {
      id: 7,
      projectUnitId: 5,
      bibleId: 3,
      bookId: 1,
      chapterNumber: 1,
      assignedUserId: null,
      peerCheckerId: null,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
      submittedTime: null,
      isAiEnabled: false,
      hasClaimConflict: false,
      claimConflictUserId: null,
      createdAt: null,
      updatedAt: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const heading = result.data.content.find(
      (node) => node.type === 'para' && node.marker === 's1'
    );
    expect(heading?.type).toBe('para');
    if (heading?.type !== 'para') return;
    expect(heading.content.every((node) => typeof node === 'string')).toBe(true);
    expect(heading.content.join('').trim()).toBe('The Creation');
    const body = result.data.content.find(
      (node) =>
        node.type === 'para' &&
        node.marker === 'p' &&
        node.content.some(
          (child) => typeof child !== 'string' && child.type === 'verse' && child.number === '2'
        )
    );
    expect(body?.type).toBe('para');
    if (body?.type !== 'para') return;
    expect(
      body.content
        .filter((node) => typeof node === 'string')
        .join('')
        .trim()
    ).toBe('Second.');
  });
});
