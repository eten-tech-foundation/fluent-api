import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@/lib/types';

import { err, ErrorCode, ok } from '@/lib/types';

import * as repo from './ai-suggestions.repository';
import { claimActivationCrossing } from './ai-suggestions.service';

vi.mock('@/env', () => ({ default: { AI_ACTIVATION_THRESHOLD_VERSES: 500 } }));
vi.mock('@/lib/logger', () => ({ logger: {} }));
vi.mock('@/lib/queue', () => ({ getQueue: vi.fn(), QUEUE_NAMES: {} }));
vi.mock('@/domains/pericopes/pericopes.service', () => ({ getChapterPericopes: vi.fn() }));

vi.mock('./ai-suggestions.repository', () => ({
  familyHasReachedAiActivationThreshold: vi.fn(),
  getAiActivationFamily: vi.fn(),
  lockAiActivationFamily: vi.fn(),
}));

const FAMILY = { sourceLanguage: 1, targetLanguage: 2, organization: 3 };

/** Everything the claim does, in order, so a test can see where the lock and the write landed. */
let steps: string[] = [];

const tx = {} as DbTransaction;

const write = vi.fn(async () => {
  steps.push('write');
  return ok('saved');
});

/** The threshold as this save sees it: the unlocked pre-check, then `before`, then `after`. */
function measures(...readings: boolean[]) {
  vi.mocked(repo.familyHasReachedAiActivationThreshold).mockImplementation(async () => {
    steps.push('measure');
    return readings.shift() ?? false;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  steps = [];
  vi.mocked(repo.lockAiActivationFamily).mockImplementation(async () => {
    steps.push('lock');
  });
  vi.mocked(repo.getAiActivationFamily).mockResolvedValue(FAMILY);
});

describe('claimActivationCrossing (#417)', () => {
  it('claims the crossing for the save that takes the family over the threshold', async () => {
    measures(false, false, true);

    const { written, crossed } = await claimActivationCrossing(tx, 7, write);

    expect(crossed).toBe(true);
    expect(written).toEqual(ok('saved'));
    expect(repo.lockAiActivationFamily).toHaveBeenCalledWith(FAMILY, tx);
    // The lock is taken before `before` is read, and `after` is read only once the row is written.
    expect(steps).toEqual(['measure', 'lock', 'measure', 'write', 'measure']);
  });

  it('reads the family once and hands it to every measurement', async () => {
    measures(false, false, true);

    await claimActivationCrossing(tx, 7, write);

    expect(repo.getAiActivationFamily).toHaveBeenCalledTimes(1);
    for (const call of vi.mocked(repo.familyHasReachedAiActivationThreshold).mock.calls) {
      expect(call[0]).toBe(FAMILY);
      expect(call[2]).toBe(tx);
    }
  });

  it('does not claim it for the save that lost the race, which finds the family already over', async () => {
    // Read 499 before the lock, then the winner commits, then this save reads 500 under it.
    measures(false, true);

    const { crossed } = await claimActivationCrossing(tx, 7, write);

    expect(crossed).toBe(false);
    expect(write).toHaveBeenCalled();
    // `before` was already over, so there is nothing `after` could add: it is not measured.
    expect(steps).toEqual(['measure', 'lock', 'measure', 'write']);
  });

  it('skips the lock entirely for a family that is already over the threshold', async () => {
    measures(true);

    const { crossed } = await claimActivationCrossing(tx, 7, write);

    expect(crossed).toBe(false);
    expect(repo.lockAiActivationFamily).not.toHaveBeenCalled();
    expect(steps).toEqual(['measure', 'write']);
  });

  it('runs the write without a lock when the project unit has no family', async () => {
    vi.mocked(repo.getAiActivationFamily).mockResolvedValue(null);

    const { crossed } = await claimActivationCrossing(tx, 7, write);

    expect(crossed).toBe(false);
    expect(repo.lockAiActivationFamily).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });

  it('measures nothing more once the write has failed, since the transaction is aborted', async () => {
    measures(false, false, true);
    const failing = vi.fn(async () => {
      steps.push('write');
      return err(ErrorCode.INTERNAL_ERROR);
    });

    const { written, crossed } = await claimActivationCrossing(tx, 7, failing);

    expect(crossed).toBe(false);
    expect(written.ok).toBe(false);
    expect(steps).toEqual(['measure', 'lock', 'measure', 'write']);
  });
});
