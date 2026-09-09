import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PericopeContext, PericopeVerse } from './ai-pericope.repository';

import { resolvePericopes, savePericopeSuggestion } from './ai-pericope.repository';
import {
  findNextUntranslatedVerses,
  getChapterAssignmentAiStatus,
  getSuggestionContextData,
  hasReachedAiActivationThreshold,
} from './ai-suggestions.repository';
import {
  getPericopeSuggestions,
  getSuggestionContext,
  queueNextVerses,
  queuePericopes,
  saveAiSuggestions,
} from './ai-suggestions.service';

const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue('job') }));
vi.mock('@/env', () => ({ default: { AI_ACTIVATION_THRESHOLD_VERSES: 5 } }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(async () => ({ send })),
  QUEUE_NAMES: { AI_SUGGESTIONS: 'ai-suggestions' },
}));
vi.mock('./ai-suggestions.repository', () => ({
  hasReachedAiActivationThreshold: vi.fn(),
  getSuggestionContextData: vi.fn(),
  upsertAiSuggestions: vi.fn(),
  getChapterAssignmentAiStatus: vi.fn(),
  findNextUntranslatedVerses: vi.fn(),
}));
vi.mock('./ai-pericope.repository', () => ({
  resolvePericopes: vi.fn(),
  savePericopeSuggestion: vi.fn(),
  logPericopeUsage: vi.fn(),
}));

const request = {
  projectUnitId: 1,
  bibleId: 2,
  bookCode: 'GEN',
  chapterNumber: 1,
  pericopeNumbers: ['4a', '4b'],
};
function verse(number: number, extras: Partial<PericopeVerse> = {}): PericopeVerse {
  return {
    bibleTextId: number + 100,
    verseNumber: number,
    content: null,
    hasAuthoredHeading: false,
    hasSuggestion: false,
    ...extras,
  };
}
let context: PericopeContext;

describe('pericope AI suggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    send.mockResolvedValue('job');
    context = {
      pericopeSetId: 5,
      isAiEnabled: true,
      groups: [
        {
          pericopeNumber: '4a',
          sourceTitle: 'Creation',
          suggestion: null,
          verses: [
            verse(1),
            verse(2, { content: '' }),
            verse(3, { content: 'Translated' }),
            verse(4, { hasSuggestion: true }),
            verse(5, { content: '   ' }),
          ],
        },
        { pericopeNumber: '4b', sourceTitle: null, suggestion: null, verses: [verse(7)] },
      ],
    };
    vi.mocked(resolvePericopes).mockImplementation(async () => ({ ok: true, data: context }));
    vi.mocked(hasReachedAiActivationThreshold).mockResolvedValue(true);
  });

  it('also propagates a failed queue submission from the legacy queue-next endpoint', async () => {
    vi.mocked(getChapterAssignmentAiStatus).mockResolvedValue(true);
    vi.mocked(findNextUntranslatedVerses).mockResolvedValue([2]);
    send.mockRejectedValueOnce(new Error('queue unavailable'));
    expect((await queueNextVerses(1, 2, 'GEN', 1, 1)).ok).toBe(false);
  });

  it('queues exact missing/empty verses including verse 1, preserves text/cache, and queues one separate title', async () => {
    expect(await queuePericopes(request)).toEqual({
      ok: true,
      data: { queued: true, thresholdMet: true },
    });
    expect(resolvePericopes).toHaveBeenCalledWith(request);
    const jobs = send.mock.calls.map((call) => call[1]);
    expect(jobs.filter((job) => !job.pericopeNumber).map((job) => job.verseStart)).toEqual([
      1, 2, 5, 7,
    ]);
    expect(jobs.find((job) => job.pericopeNumber)).toEqual({
      projectUnitId: 1,
      bibleId: 2,
      bookCode: 'GEN',
      chapterNumber: 1,
      verseStart: 1,
      verseEnd: 5,
      pericopeNumber: '4a',
      pericopeSetId: 5,
    });
    expect(send.mock.calls[0][2].singletonKey).toBe('1:2:GEN:1:1');
    expect(send.mock.calls[3][2].singletonKey).toBe('heading:1:2:GEN:1:1:5:5:4a');
  });

  it.each([false, true])(
    'does not queue when threshold=%s and the assignment is disabled',
    async (thresholdMet) => {
      context.isAiEnabled = false;
      vi.mocked(hasReachedAiActivationThreshold).mockResolvedValue(thresholdMet);
      expect(await queuePericopes(request)).toEqual({
        ok: true,
        data: { queued: false, thresholdMet },
      });
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('does not queue before the activation threshold', async () => {
    vi.mocked(hasReachedAiActivationThreshold).mockResolvedValue(false);
    expect(await queuePericopes(request)).toEqual({
      ok: true,
      data: { queued: false, thresholdMet: false },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an invalid batch before queuing any job', async () => {
    vi.mocked(resolvePericopes).mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_REFERENCE', message: 'Invalid reference' },
    });
    expect((await queuePericopes(request)).ok).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves authored headings and omits title-less groups', async () => {
    context.groups[0].verses[0].hasAuthoredHeading = true;
    await queuePericopes(request);
    expect(send.mock.calls.every((call) => call[1].pericopeNumber === undefined)).toBe(true);
  });

  it('does not regenerate cached titles or already suggested verses', async () => {
    context.groups = [context.groups[0]];
    context.groups[0].verses.forEach((row) => {
      row.hasSuggestion = true;
    });
    context.groups[0].suggestion = {
      id: 1,
      projectUnitId: 1,
      bibleTextId: 101,
      pericopeSetId: 5,
      pericopeNumber: '4a',
      suggestedText: 'The creation',
      modelInfo: null,
      createdAt: new Date(),
    };
    expect(await queuePericopes(request)).toEqual({
      ok: true,
      data: { queued: false, thresholdMet: true },
    });
    expect(send).not.toHaveBeenCalled();
    expect(await getPericopeSuggestions(request)).toEqual({
      ok: true,
      data: {
        data: [
          {
            bibleTextId: 101,
            pericopeNumber: '4a',
            suggestedText: 'The creation',
            modelInfo: null,
          },
        ],
      },
    });
    context.groups[0].verses[0].hasAuthoredHeading = true;
    expect(await getPericopeSuggestions(request)).toEqual({ ok: true, data: { data: [] } });
  });

  it('propagates queue failures, but accepts singleton deduplication', async () => {
    send.mockRejectedValueOnce(new Error('queue unavailable'));
    expect((await queuePericopes(request)).ok).toBe(false);
    send.mockResolvedValue(null);
    expect((await queuePericopes(request)).ok).toBe(true);
  });

  it('derives heading context and removes non-group source verses from a sparse range', async () => {
    context.groups[0].verses = [verse(1), verse(3)];
    vi.mocked(getSuggestionContextData).mockResolvedValue({
      ok: true,
      data: {
        targetLanguageName: 'Hindi',
        contextVerses: [],
        sourceVerses: [1, 2, 3].map((number) => ({
          id: number + 100,
          verse_number: number,
          text: 'source',
        })),
      },
    });
    const result = await getSuggestionContext({
      ...request,
      verseStart: 1,
      verseEnd: 3,
      pericopeNumber: '4a',
      pericopeSetId: 5,
    });
    expect(result.ok && result.data.sectionHeading).toEqual({
      pericopeNumber: '4a',
      pericopeSetId: 5,
      bibleTextId: 101,
      sourceTitle: 'Creation',
    });
    expect(result.ok && result.data.sourceVerses.map((row) => row.id)).toEqual([101, 103]);
  });

  it.each([
    { verseStart: 2, verseEnd: 5, pericopeSetId: 5 },
    { verseStart: 1, verseEnd: 5, pericopeSetId: 6 },
  ])('rejects mismatched ranges and old-set jobs', async (fields) => {
    expect((await getSuggestionContext({ ...request, ...fields, pericopeNumber: '4a' })).ok).toBe(
      false
    );
    expect(getSuggestionContextData).not.toHaveBeenCalled();
  });

  it('returns an explicit null heading when no source title exists', async () => {
    context.groups[0].sourceTitle = null;
    vi.mocked(getSuggestionContextData).mockResolvedValue({
      ok: true,
      data: {
        targetLanguageName: 'Hindi',
        contextVerses: [],
        sourceVerses: [],
      },
    });
    const result = await getSuggestionContext({
      ...request,
      verseStart: 1,
      verseEnd: 5,
      pericopeNumber: '4a',
    });
    expect(result.ok && result.data.sectionHeading).toBeNull();
  });

  it('saves heading results only through the separate repository', async () => {
    const heading = {
      projectUnitId: 1,
      bibleTextId: 101,
      pericopeNumber: '4a',
      pericopeSetId: 5,
      suggestedText: 'Title',
    };
    vi.mocked(savePericopeSuggestion).mockResolvedValue({ ok: true, data: undefined });
    expect((await saveAiSuggestions([], heading)).ok).toBe(true);
    expect(savePericopeSuggestion).toHaveBeenCalledWith(heading);
    expect(
      (
        await saveAiSuggestions(
          [{ projectUnitId: 1, bibleTextId: 101, suggestedText: 'Verse' }],
          heading
        )
      ).ok
    ).toBe(false);
  });
});
