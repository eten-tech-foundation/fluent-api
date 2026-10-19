import type { JobWithMetadata } from 'pg-boss';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AiSuggestionTriggerJob } from '@/lib/queue';

import { triggerAiSuggestions } from '@/lib/services/fluent-ai/fluent-ai.client';
import { fakeBoss, jobResult } from '@/test/utils/test-helpers';

import { registerAiTriggerWorker } from './ai-trigger.worker';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/services/fluent-ai/fluent-ai.client', () => ({
  triggerAiSuggestions: vi.fn(),
}));

const base = { projectUnitId: 1, bibleId: 2, bookCode: 'JHN', chapterNumber: 3 };
const title = { ...base, verseStart: 1, verseEnd: 8, pericopeNumber: '9', pericopeSetId: 2 };
const verse = (verseStart: number) => ({ ...base, verseStart, verseEnd: verseStart });

/** A fetched job as pg-boss hands it over with includeMetadata: only createdOn matters here. */
function fetched(data: AiSuggestionTriggerJob, createdOn: string) {
  return {
    ...jobResult(data, { name: 'ai-suggestions' }),
    createdOn: new Date(createdOn),
  } as unknown as JobWithMetadata<AiSuggestionTriggerJob>;
}

async function registeredHandler() {
  const { boss, work } = fakeBoss();
  await registerAiTriggerWorker(boss, {});
  return {
    options: work.mock.calls[0][1],
    run: work.mock.calls[0][2] as (
      jobs: JobWithMetadata<AiSuggestionTriggerJob>[]
    ) => Promise<void>,
  };
}

describe('registerAiTriggerWorker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(triggerAiSuggestions).mockResolvedValue(undefined);
  });

  it('forwards a batch oldest first, one fluent-ai request per job', async () => {
    const { options, run } = await registeredHandler();
    expect(options).toMatchObject({ batchSize: 5, includeMetadata: true });

    // pg-boss returns a fetched batch in no set order.
    await run([
      fetched(verse(2), '2026-10-19T12:00:00.003Z'),
      fetched(title, '2026-10-19T12:00:00.001Z'),
      fetched(verse(1), '2026-10-19T12:00:00.002Z'),
    ]);

    // fluent-ai runs jobs by the time it stored them, and a single request would store the
    // whole batch at one time, so the title could still run after its verses.
    expect(vi.mocked(triggerAiSuggestions).mock.calls).toEqual([
      [[title]],
      [[verse(1)]],
      [[verse(2)]],
    ]);
  });

  it('rejects, so pg-boss retries the batch, when fluent-ai refuses a job', async () => {
    const { run } = await registeredHandler();
    vi.mocked(triggerAiSuggestions)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('fluent-ai returned HTTP 503'));

    await expect(
      run([
        fetched(title, '2026-10-19T12:00:00.001Z'),
        fetched(verse(1), '2026-10-19T12:00:00.002Z'),
        fetched(verse(2), '2026-10-19T12:00:00.003Z'),
      ])
    ).rejects.toThrow('HTTP 503');
    expect(triggerAiSuggestions).toHaveBeenCalledTimes(2);
  });
});
