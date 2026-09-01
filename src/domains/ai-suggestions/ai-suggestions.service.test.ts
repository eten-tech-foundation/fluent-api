import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getQueue } from '@/lib/queue';

import * as pericopeRepo from './ai-suggestions.pericope.repository';
import * as repo from './ai-suggestions.repository';
import * as service from './ai-suggestions.service';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/env', () => ({
  default: {
    AI_ACTIVATION_THRESHOLD_VERSES: 500,
    AI_DEFAULT_LOOKAHEAD: 3,
    AI_INITIAL_QUEUE_COUNT: 3,
    AI_MAX_REQUESTED_BIBLE_TEXT_IDS: 200,
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/queue', () => ({
  getQueue: vi.fn(),
  QUEUE_NAMES: { AI_SUGGESTIONS: 'ai-suggestions' },
}));

vi.mock('./ai-suggestions.repository', () => ({
  checkBibleTextsExist: vi.fn(),
  findNextUntranslatedVerses: vi.fn(),
  getAiSuggestions: vi.fn(),
  getBookCodeById: vi.fn(),
  getChapterAssignmentAiStatus: vi.fn(),
  getSuggestionContextData: vi.fn(),
  hasReachedAiActivationThreshold: vi.fn(),
  logAiSuggestionUsage: vi.fn(),
  upsertAiSuggestions: vi.fn(),
}));

vi.mock('./ai-suggestions.pericope.repository', () => ({
  findVersesNeedingSuggestions: vi.fn(),
  getBibleTextLocation: vi.fn(),
  getChapterPericopeVerseGroups: vi.fn(),
  isExactlyAtAiActivationThreshold: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const UNIT = 7;
const BIBLE = 3;
const BOOK = 'GEN';
const CHAPTER = 1;

/** Genesis 1 cut three ways: 1-3, 4-7, 8-9. */
const PERICOPES = [
  [1, 2, 3],
  [4, 5, 6, 7],
  [8, 9],
];

const send = vi.fn();

/** Every verseStart handed to pgboss, in order. */
const sentVerses = () =>
  send.mock.calls.map((call) => (call[1] as { verseStart: number }).verseStart);

/** The verses a call asked to have checked, so a test can see the pericope decision itself. */
const askedToCheck = () =>
  vi.mocked(pericopeRepo.findVersesNeedingSuggestions).mock.calls.map((call) => call[4]);

beforeEach(() => {
  vi.clearAllMocks();
  send.mockResolvedValue('job-id');
  vi.mocked(getQueue).mockResolvedValue({ send } as never);
  vi.mocked(repo.hasReachedAiActivationThreshold).mockResolvedValue(true);
  vi.mocked(repo.getChapterAssignmentAiStatus).mockResolvedValue(true);
  vi.mocked(pericopeRepo.getChapterPericopeVerseGroups).mockResolvedValue(PERICOPES);
  // By default nothing is drafted or suggested yet, so whatever is asked for is what goes out.
  vi.mocked(pericopeRepo.findVersesNeedingSuggestions).mockImplementation(
    async (_u, _b, _c, _ch, verses) => verses
  );
});

// ─── Navigation-triggered queuing ─────────────────────────────────────────────

describe('queueNextVerses (#417)', () => {
  it('queues the pericope the translator is in and the one after it', async () => {
    const result = await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 2);

    expect(result).toEqual({ ok: true, data: { queued: true, thresholdMet: true } });
    expect(askedToCheck()).toEqual([[1, 2, 3, 4, 5, 6, 7]]);
    expect(sentVerses()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('gives the same answer from any verse of the same pericope, so both views agree', async () => {
    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 5);
    expect(sentVerses()).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('does not cross the chapter boundary from the last pericope', async () => {
    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 9);

    expect(askedToCheck()).toEqual([[8, 9]]);
    expect(sentVerses()).toEqual([8, 9]);
  });

  it('leaves out verses that already have a draft or a suggestion', async () => {
    vi.mocked(pericopeRepo.findVersesNeedingSuggestions).mockResolvedValue([3, 6, 7]);

    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 1);

    expect(sentVerses()).toEqual([3, 6, 7]);
  });

  it('sends one job per verse, deduplicated per verse', async () => {
    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 8);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith(
      'ai-suggestions',
      {
        projectUnitId: UNIT,
        bibleId: BIBLE,
        bookCode: BOOK,
        chapterNumber: CHAPTER,
        verseStart: 8,
        verseEnd: 8,
      },
      { singletonKey: `${UNIT}:${BIBLE}:${BOOK}:${CHAPTER}:8` }
    );
  });

  it('queues nothing for a verse that belongs to no pericope', async () => {
    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 42);

    expect(send).not.toHaveBeenCalled();
    expect(pericopeRepo.findVersesNeedingSuggestions).not.toHaveBeenCalled();
  });

  it('falls back to the fixed look-ahead when the project has no pericope set', async () => {
    vi.mocked(pericopeRepo.getChapterPericopeVerseGroups).mockResolvedValue([]);
    vi.mocked(repo.findNextUntranslatedVerses).mockResolvedValue([3, 4, 5]);

    await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 2);

    expect(repo.findNextUntranslatedVerses).toHaveBeenCalledWith(UNIT, BIBLE, BOOK, CHAPTER, 2, 3);
    expect(sentVerses()).toEqual([3, 4, 5]);
  });

  it('reports the threshold and queues nothing below it', async () => {
    vi.mocked(repo.hasReachedAiActivationThreshold).mockResolvedValue(false);

    const result = await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 2);

    expect(result).toEqual({ ok: true, data: { queued: false, thresholdMet: false } });
    expect(send).not.toHaveBeenCalled();
  });

  it('queues nothing while the AI toggle is off for the chapter', async () => {
    vi.mocked(repo.getChapterAssignmentAiStatus).mockResolvedValue(false);

    const result = await service.queueNextVerses(UNIT, BIBLE, BOOK, CHAPTER, 2);

    expect(result).toEqual({ ok: true, data: { queued: false, thresholdMet: true } });
    expect(send).not.toHaveBeenCalled();
  });

  it('upper-cases the book code before it reaches the queue', async () => {
    await service.queueNextVerses(UNIT, BIBLE, 'gen', CHAPTER, 8);
    expect((send.mock.calls[0][1] as { bookCode: string }).bookCode).toBe('GEN');
  });
});

// ─── Assignment-time queuing ──────────────────────────────────────────────────

describe('handleChapterAssigned (#417)', () => {
  beforeEach(() => {
    vi.mocked(repo.getBookCodeById).mockResolvedValue('GEN');
  });

  it('queues only the first pericope of the chapter', async () => {
    await service.handleChapterAssigned(UNIT, BIBLE, 11, CHAPTER);

    expect(askedToCheck()).toEqual([[1, 2, 3]]);
    expect(sentVerses()).toEqual([1, 2, 3]);
  });

  it('respects the AI toggle, which the assignment path never checked before', async () => {
    vi.mocked(repo.getChapterAssignmentAiStatus).mockResolvedValue(false);

    await service.handleChapterAssigned(UNIT, BIBLE, 11, CHAPTER);

    expect(send).not.toHaveBeenCalled();
  });

  it('queues nothing below the threshold', async () => {
    vi.mocked(repo.hasReachedAiActivationThreshold).mockResolvedValue(false);

    await service.handleChapterAssigned(UNIT, BIBLE, 11, CHAPTER);

    expect(send).not.toHaveBeenCalled();
  });

  it('falls back to the initial verse count without a pericope set', async () => {
    vi.mocked(pericopeRepo.getChapterPericopeVerseGroups).mockResolvedValue([]);
    vi.mocked(repo.findNextUntranslatedVerses).mockResolvedValue([1, 2, 3]);

    await service.handleChapterAssigned(UNIT, BIBLE, 11, CHAPTER);

    expect(repo.findNextUntranslatedVerses).toHaveBeenCalledWith(UNIT, BIBLE, 'GEN', CHAPTER, 0, 3);
    expect(sentVerses()).toEqual([1, 2, 3]);
  });
});

// ─── Threshold backfill ───────────────────────────────────────────────────────

describe('handleThresholdCrossed (#417)', () => {
  const TEXT_ID = 900;

  beforeEach(() => {
    vi.mocked(pericopeRepo.isExactlyAtAiActivationThreshold).mockResolvedValue(true);
    vi.mocked(pericopeRepo.getBibleTextLocation).mockResolvedValue({
      bibleId: BIBLE,
      bookCode: 'gen',
      chapterNumber: CHAPTER,
    });
  });

  it('is a no-op for any save that is not the crossing one', async () => {
    vi.mocked(pericopeRepo.isExactlyAtAiActivationThreshold).mockResolvedValue(false);

    await service.handleThresholdCrossed(UNIT, TEXT_ID);

    expect(pericopeRepo.getBibleTextLocation).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('backfills the first pericope of the current chapter and of the next one', async () => {
    await service.handleThresholdCrossed(UNIT, TEXT_ID);

    expect(pericopeRepo.getChapterPericopeVerseGroups).toHaveBeenCalledWith(UNIT, 'GEN', 1);
    expect(pericopeRepo.getChapterPericopeVerseGroups).toHaveBeenCalledWith(UNIT, 'GEN', 2);
    // Both chapters share the fixture, so it is the first pericope twice.
    expect(sentVerses()).toEqual([1, 2, 3, 1, 2, 3]);
    expect(
      send.mock.calls.map((call) => (call[1] as { chapterNumber: number }).chapterNumber)
    ).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('skips the next chapter when it is not assigned in this unit', async () => {
    vi.mocked(repo.getChapterAssignmentAiStatus).mockImplementation(async (_u, _b, _c, chapter) =>
      chapter === 1 ? true : null
    );

    await service.handleThresholdCrossed(UNIT, TEXT_ID);

    expect(
      send.mock.calls.every((call) => (call[1] as { chapterNumber: number }).chapterNumber === 1)
    ).toBe(true);
    expect(sentVerses()).toEqual([1, 2, 3]);
  });

  it('applies the AI toggle to each chapter separately', async () => {
    vi.mocked(repo.getChapterAssignmentAiStatus).mockImplementation(
      async (_u, _b, _c, chapter) => chapter === 2
    );

    await service.handleThresholdCrossed(UNIT, TEXT_ID);

    expect(sentVerses()).toEqual([1, 2, 3]);
    expect((send.mock.calls[0][1] as { chapterNumber: number }).chapterNumber).toBe(2);
  });

  it('does nothing when the saved verse cannot be located', async () => {
    vi.mocked(pericopeRepo.getBibleTextLocation).mockResolvedValue(null);

    await service.handleThresholdCrossed(UNIT, TEXT_ID);

    expect(send).not.toHaveBeenCalled();
  });
});
