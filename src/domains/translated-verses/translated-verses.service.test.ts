import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Result } from '@/lib/types';

import * as aiSuggestionsService from '@/domains/ai-suggestions/ai-suggestions.service';
import { err, ErrorCode, ok } from '@/lib/types';

import type { TranslatedVerseRecord } from './translated-verses.types';

import * as repo from './translated-verses.repository';
import * as service from './translated-verses.service';

// ─── Module mocks ─────────────────────────────────────────────────────────────

/**
 * A stand-in transaction. `committed` flips once the callback has returned, which is what lets a
 * test see whether the AI backfill ran inside the transaction or after it.
 */
const { tx, state, transaction } = vi.hoisted(() => {
  const tx = { __tx: true };
  const state = { committed: false };
  const transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const result = await callback(tx);
    state.committed = true;
    return result;
  });
  return { tx, state, transaction };
});

vi.mock('@/db', () => ({ db: { transaction } }));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/ai-suggestions/ai-suggestions.service', () => ({
  claimActivationCrossing: vi.fn(),
  handleThresholdCrossed: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  touchProjectActivity: vi.fn(),
}));

vi.mock('./translated-verses.repository', () => ({
  create: vi.fn(),
  getById: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
  upsert: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const UNIT = 7;
const TEXT_ID = 900;

const INPUT = { projectUnitId: UNIT, bibleTextId: TEXT_ID, content: 'a drafted verse' };

const SAVED: TranslatedVerseRecord = {
  id: 1,
  projectUnitId: UNIT,
  bibleTextId: TEXT_ID,
  content: 'a drafted verse',
  markers: null,
  assignedUserId: null,
  verseNumber: 4,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/**
 * Replaces the real claim with its own rule — crossed when the family was below the threshold
 * before the write and at or above it after — so a test can put the save on either side of the
 * crossing without standing up a database.
 */
function claimWith(before: boolean, after: boolean) {
  vi.mocked(aiSuggestionsService.claimActivationCrossing).mockImplementation(
    async (_tx, _projectUnitId, write) => {
      const written = (await write()) as Result<unknown>;
      if (!written.ok) return { written, crossed: false };
      return { written, crossed: !before && after };
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.committed = false;
  vi.mocked(repo.upsert).mockResolvedValue(ok(SAVED));
  claimWith(false, false);
});

// ─── The threshold claim (#417) ───────────────────────────────────────────────

describe('upsertTranslatedVerse (#417)', () => {
  it('runs the save under the claim, on the transaction it opened', async () => {
    await service.upsertTranslatedVerse(INPUT);

    expect(aiSuggestionsService.claimActivationCrossing).toHaveBeenCalledWith(
      tx,
      UNIT,
      expect.any(Function)
    );
    expect(repo.upsert).toHaveBeenCalledWith(INPUT, tx);
  });

  it('backfills the AI queue for the save that crosses the threshold', async () => {
    claimWith(false, true);

    const result = await service.upsertTranslatedVerse(INPUT);

    expect(result.ok).toBe(true);
    expect(aiSuggestionsService.handleThresholdCrossed).toHaveBeenCalledWith(UNIT, TEXT_ID);
  });

  it('does not backfill for an edit made once the family is already over the threshold', async () => {
    claimWith(true, true);

    await service.upsertTranslatedVerse(INPUT);

    expect(aiSuggestionsService.handleThresholdCrossed).not.toHaveBeenCalled();
  });

  it('does not backfill for a save that leaves the family below the threshold', async () => {
    claimWith(false, false);

    await service.upsertTranslatedVerse(INPUT);

    expect(aiSuggestionsService.handleThresholdCrossed).not.toHaveBeenCalled();
  });

  it('sends the backfill only after the transaction has committed', async () => {
    claimWith(false, true);
    let committedWhenCalled: boolean | null = null;
    vi.mocked(aiSuggestionsService.handleThresholdCrossed).mockImplementation(async () => {
      committedWhenCalled = state.committed;
      return ok(undefined);
    });

    await service.upsertTranslatedVerse(INPUT);

    expect(committedWhenCalled).toBe(true);
  });

  it('returns the save error and backfills nothing when the upsert fails', async () => {
    claimWith(false, true);
    vi.mocked(repo.upsert).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const result = await service.upsertTranslatedVerse(INPUT);

    expect(result.ok).toBe(false);
    expect(aiSuggestionsService.handleThresholdCrossed).not.toHaveBeenCalled();
  });

  it('keeps the draft saved when the backfill throws', async () => {
    claimWith(false, true);
    vi.mocked(aiSuggestionsService.handleThresholdCrossed).mockRejectedValue(
      new Error('queue is down')
    );

    const result = await service.upsertTranslatedVerse(INPUT);

    expect(result.ok).toBe(true);
  });
});
