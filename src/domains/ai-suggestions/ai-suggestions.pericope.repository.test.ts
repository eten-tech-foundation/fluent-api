import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@/lib/types';

import { err, ErrorCode, ok } from '@/lib/types';

import { claimAiActivationCrossing } from './ai-suggestions.pericope.repository';
import * as repo from './ai-suggestions.repository';

vi.mock('@/db', () => ({ db: {} }));

vi.mock('./ai-suggestions.repository', () => ({
  getAiActivationFamily: vi.fn(),
  hasReachedAiActivationThreshold: vi.fn(),
}));

const THRESHOLD = 500;
const FAMILY = { sourceLanguage: 1, targetLanguage: 2, organization: 3 };

/** Everything the claim does, in order, so a test can see where the lock and the write landed. */
let steps: string[] = [];

const execute = vi.fn(async () => {
  steps.push('lock');
});
const tx = { execute } as unknown as DbTransaction;

const write = vi.fn(async () => {
  steps.push('write');
  return ok('saved');
});

/** The threshold as this save sees it: the unlocked pre-check, then `before`, then `after`. */
function measures(...readings: boolean[]) {
  vi.mocked(repo.hasReachedAiActivationThreshold).mockImplementation(async () => {
    steps.push('measure');
    return readings.shift() ?? false;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  steps = [];
  vi.mocked(repo.getAiActivationFamily).mockResolvedValue(FAMILY);
});

describe('claimAiActivationCrossing (#417)', () => {
  it('claims the crossing for the save that takes the family over the threshold', async () => {
    measures(false, false, true);

    const { written, crossed } = await claimAiActivationCrossing(tx, 7, THRESHOLD, write);

    expect(crossed).toBe(true);
    expect(written).toEqual(ok('saved'));
    // The lock is taken before `before` is read, and `after` is read only once the row is written.
    expect(steps).toEqual(['measure', 'lock', 'measure', 'write', 'measure']);
  });

  it('locks on the family, not on the project unit', async () => {
    measures(false, false, true);

    await claimAiActivationCrossing(tx, 7, THRESHOLD, write);

    const [statement] = execute.mock.calls[0] as unknown as [{ queryChunks?: unknown[] }];
    expect(JSON.stringify(statement)).toContain('ai-activation:1:2:3');
  });

  it('does not claim it for the save that lost the race, which finds the family already over', async () => {
    // Read 499 before the lock, then the winner commits, then this save reads 500 under it.
    measures(false, true, true);

    const { crossed } = await claimAiActivationCrossing(tx, 7, THRESHOLD, write);

    expect(crossed).toBe(false);
    expect(write).toHaveBeenCalled();
  });

  it('skips the lock entirely for a family that is already over the threshold', async () => {
    measures(true);

    const { crossed } = await claimAiActivationCrossing(tx, 7, THRESHOLD, write);

    expect(crossed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(steps).toEqual(['measure', 'write']);
  });

  it('runs the write without a lock when the project unit has no family', async () => {
    vi.mocked(repo.getAiActivationFamily).mockResolvedValue(null);

    const { crossed } = await claimAiActivationCrossing(tx, 7, THRESHOLD, write);

    expect(crossed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalled();
  });

  it('measures nothing more once the write has failed, since the transaction is aborted', async () => {
    measures(false, false, true);
    const failing = vi.fn(async () => {
      steps.push('write');
      return err(ErrorCode.INTERNAL_ERROR);
    });

    const { written, crossed } = await claimAiActivationCrossing(tx, 7, THRESHOLD, failing);

    expect(crossed).toBe(false);
    expect(written.ok).toBe(false);
    expect(steps).toEqual(['measure', 'lock', 'measure', 'write']);
  });
});
