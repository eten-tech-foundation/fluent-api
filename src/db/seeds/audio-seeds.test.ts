import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bible_texts, chapter_assignments, project_units, projects, user_roles } from '@/db/schema';

import { seedAudioDemo } from './audio-demo';
import { seedBsbBibleTexts } from './bible-texts-bsb';

const { dbMock, txMock } = vi.hoisted(() => ({
  dbMock: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
  },
  txMock: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn() },
}));
vi.mock('@/db', () => ({ db: dbMock }));

function selectResult(rows: unknown[]) {
  const result = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return result;
}

function insertResult(rows: unknown[] = []) {
  return {
    values: vi.fn().mockReturnThis(),
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
    returning: vi.fn().mockResolvedValue(rows),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  dbMock.transaction.mockImplementation((work: (tx: typeof txMock) => Promise<void>) =>
    work(txMock)
  );
  dbMock.insert.mockReturnValue(insertResult());
});

describe('audio seed persistence contracts (regular gate, no database or provider key)', () => {
  it('fills BSB texts using conflict-safe inserts, never a reset that destroys referenced verse IDs', async () => {
    dbMock.select
      .mockImplementationOnce(() =>
        selectResult([{ id: 2, provider: 'dbl', externalId: 'bba9f40183526463-01' }])
      )
      .mockImplementationOnce(() => selectResult([{ id: 43 }]));
    const insert = insertResult();
    txMock.insert.mockReturnValue(insert);
    await seedBsbBibleTexts();
    expect(dbMock.transaction).toHaveBeenCalledOnce();
    expect(txMock.insert.mock.calls.map(([table]) => table)).toEqual([bible_texts, bible_texts]);
    expect(insert.values.mock.calls.map(([rows]) => rows.length)).toEqual([500, 378]);
    expect(insert.onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        bible_texts.bibleId,
        bible_texts.bookId,
        bible_texts.chapterNumber,
        bible_texts.verseNumber,
      ],
    });
    expect(txMock.delete).not.toHaveBeenCalled();
    expect(txMock.update).not.toHaveBeenCalled();
    expect(dbMock.delete).not.toHaveBeenCalled();
  });

  it('propagates insert failure rather than reporting a partially seeded corpus as complete', async () => {
    dbMock.select
      .mockImplementationOnce(() =>
        selectResult([{ id: 2, provider: 'dbl', externalId: 'bba9f40183526463-01' }])
      )
      .mockImplementationOnce(() => selectResult([{ id: 43 }]));
    const insert = insertResult();
    insert.onConflictDoNothing.mockRejectedValue(new Error('insertion failed'));
    txMock.insert.mockReturnValue(insert);
    await expect(seedBsbBibleTexts()).rejects.toThrow('insertion failed');
  });

  it.each([false, true])(
    'creates or preserves the local demo (already exists=%s) without overwriting assignments',
    async (exists) => {
      const refs = [
        { id: 1 },
        { id: 2 },
        { id: 3, languageId: 4 },
        { id: 43 },
        { id: 5 },
        { id: 6 },
        { id: 7 },
      ];
      for (const ref of refs) dbMock.select.mockImplementationOnce(() => selectResult([ref]));
      txMock.select
        .mockImplementationOnce(() => selectResult(exists ? [{ id: 8 }] : []))
        .mockImplementationOnce(() => selectResult(exists ? [{ id: 9 }] : []))
        .mockImplementationOnce(() => selectResult(exists ? [{ projectUnitId: 9 }] : []));
      const projectInsert = insertResult([{ id: 8 }]);
      const unitInsert = insertResult([{ id: 9 }]);
      const insert = insertResult();
      txMock.insert.mockImplementation((table) =>
        table === projects ? projectInsert : table === project_units ? unitInsert : insert
      );
      await seedAudioDemo('local', 'Fluent Dev', 'pm@fluent.local');
      expect(txMock.execute).toHaveBeenCalledOnce(); // serialized seed-marker lookup
      if (exists) {
        expect(txMock.insert.mock.calls.map(([table]) => table)).toEqual([
          user_roles,
          chapter_assignments,
        ]);
      } else {
        expect(projectInsert.values).toHaveBeenCalledWith(
          expect.objectContaining({
            name: 'Source Audio Demo — BSB John',
            pericopeSetId: 6,
            metadata: { seed: 'source-audio-bsb-jhn' },
          })
        );
      }
      expect(insert.values).toHaveBeenCalledWith(
        expect.objectContaining({
          projectUnitId: 9,
          bibleId: 3,
          bookId: 43,
          chapterNumber: 3,
          assignedUserId: 2,
          isAiEnabled: false,
        })
      );
      expect(insert.onConflictDoNothing).toHaveBeenCalledWith({
        target: [
          chapter_assignments.projectUnitId,
          chapter_assignments.bibleId,
          chapter_assignments.bookId,
          chapter_assignments.chapterNumber,
        ],
      });
      expect(txMock.update).not.toHaveBeenCalled();
      expect(txMock.delete).not.toHaveBeenCalled();
    }
  );
});
