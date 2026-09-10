import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BibleAudioResponse } from '@/domains/bibles/bible-audio/bible-audio.types';
import type { Bible } from '@/domains/bibles/bibles.types';
import type { AquiferBible, AquiferBibleTextResponse } from '@/lib/services/aquifer/aquifer.types';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { logger } from '@/lib/logger';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';

import { getChapterSourceAudio } from './source-audio.service';
import { sourceAudioResponseSchema } from './source-audio.types';

vi.mock('@/domains/bibles/bibles.repository', () => ({ getById: vi.fn() }));
vi.mock('@/domains/books/books.service', () => ({ getBookByCode: vi.fn() }));
vi.mock('@/domains/bibles/bible-audio/bible-audio.service', () => ({ getSourceAudio: vi.fn() }));
vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getBibles: vi.fn(),
  getBibleText: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn() } }));

const bible: Bible = {
  id: 1,
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageId: 1,
  provider: 'dbl',
  aquiferBibleId: 1,
  externalId: 'dbl-bsb',
  ttsLicenseStatus: 'allowed',
  licenseNotice: 'BSB. Public domain.',
  createdAt: null,
  updatedAt: null,
};
const pinned: AquiferBible = { id: 1, name: 'BSB', abbreviation: 'BSB' };
const other: AquiferBible = { id: 2, name: 'BSB', abbreviation: 'BSB' };
const input = { fluentBibleId: 1, languageCode: 'eng', bookCode: 'JHN' as const, chapter: 3 };
type Verse = AquiferBibleTextResponse['chapters'][number]['verses'][number];
const windows: Verse[] = [1, 2, 3].map((number) => ({
  number,
  text: `Verse ${number}`,
  audioTimestamp: { start: (number - 1) * 10, end: number * 10 },
}));
const windowless = windows.map(({ number, text }) => ({ number, text }));

function chapter(id = 1, verses: Verse[] = windows): AquiferBibleTextResponse {
  return {
    bibleId: id,
    bibleName: 'BSB',
    bibleAbbreviation: 'BSB',
    bookCode: 'JHN',
    bookName: 'John',
    chapters: [{ number: 3, verses, audio: { mp3: { url: `https://example.com/${id}.mp3` } } }],
  };
}

// DBL timecodes remain contract-shaped, not live-proven: the live sweep found none published.
function track(id = 'audio-1', verses: number[] = [1, 2, 3]): BibleAudioResponse {
  return {
    audioBibleId: id,
    name: id,
    chapterId: 'JHN.3',
    resourceUrl: `https://example.com/${id}.mp3`,
    expiresAt: null,
    timecodes: verses.map((verse) => ({
      verseId: `JHN.3.${verse}`,
      start: String((verse - 1) * 10),
      end: String(verse * 10),
    })),
  };
}

async function resolve() {
  const result = await getChapterSourceAudio(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.code);
  // Test the published schema as well as the service's inferred TypeScript shape.
  return sourceAudioResponseSchema.parse(result.data);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(biblesRepo.getById).mockResolvedValue(ok(bible));
  vi.mocked(getBookByCode).mockResolvedValue(ok({ id: 43, code: 'JHN', eng_display_name: 'John' }));
  vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
  vi.mocked(getBibles).mockResolvedValue(ok([pinned]));
  vi.mocked(getBibleText).mockResolvedValue(ok(chapter()));
});

describe('the source-audio ladder', () => {
  it('a pinned Aquifer Bible with windows is not displaced by a linked DBL Bible without them', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track('audio-1', [])]));
    expect(await resolve()).toMatchObject({
      provider: 'aquifer',
      verseAddressable: true,
      bible: { aquiferBibleId: 1 },
      verseTimestamps: windows.map((v) => ({ verse: v.number })),
    });
    expect(getBibles).toHaveBeenCalledExactlyOnceWith('eng');
    expect(getBibleText).toHaveBeenCalledExactlyOnceWith({
      aquiferBibleId: 1,
      bookCode: 'JHN',
      startChapter: 3,
      endChapter: 3,
      includeAudio: true,
    });
    expect(bibleAudioService.getSourceAudio).not.toHaveBeenCalled();
    expect(getBookByCode).not.toHaveBeenCalled();
  });

  it('rung 2 beats a windowless pin, returning every DBL track in server order', async () => {
    vi.mocked(getBibleText).mockResolvedValue(ok(chapter(1, windowless)));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([track('primary-without-windows', []), track('second-with-windows')])
    );
    const result = await resolve();
    expect(result.provider).toBe('dbl');
    expect(result.verseAddressable).toBe(true);
    expect(result.bible.dblAudioBibleId).toBe('primary-without-windows');
    expect(result.items.map((item) => item.dblAudioBibleId)).toEqual([
      'primary-without-windows',
      'second-with-windows',
    ]);
    expect(result.verseTimestamps).toHaveLength(3);
    expect(result.verseTimestamps?.every((v) => v.dblAudioBibleId === 'second-with-windows')).toBe(
      true
    );
    expect(bibleAudioService.getSourceAudio).toHaveBeenCalledExactlyOnceWith(1, 43, 3);
    expect(getBibleText).toHaveBeenCalledTimes(1);
  });

  it('rung 3 wins when the pin and link are windowless, reusing the catalogue', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([other, pinned]));
    vi.mocked(getBibleText).mockImplementation(async ({ aquiferBibleId }) =>
      ok(chapter(aquiferBibleId, aquiferBibleId === 1 ? windowless : windows))
    );
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track('dbl', [])]));
    expect(await resolve()).toMatchObject({
      provider: 'aquifer',
      verseAddressable: true,
      bible: { aquiferBibleId: 2 },
    });
    expect(getBibles).toHaveBeenCalledTimes(1);
    expect(getBibleText).toHaveBeenCalledTimes(2);
    expect(vi.mocked(getBibleText).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bibleAudioService.getSourceAudio).mock.invocationCallOrder[0]!
    );
    expect(vi.mocked(getBibleText).mock.invocationCallOrder[1]).toBeGreaterThan(
      vi.mocked(bibleAudioService.getSourceAudio).mock.invocationCallOrder[0]!
    );
  });

  it('rung 4 returns DBL before Aquifer when both are windowless, explicitly labelled', async () => {
    vi.mocked(getBibleText).mockResolvedValue(ok(chapter(1, windowless)));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track('dbl', [])]));
    const result = await resolve();
    expect(result).toMatchObject({ provider: 'dbl', verseAddressable: false });
    expect(result.items).toHaveLength(1);
    expect(result).not.toHaveProperty('verseTimestamps');
    // The heuristic resolves to the pin, so there is no duplicate chapter fetch.
    expect(getBibleText).toHaveBeenCalledTimes(1);
    expect(getBibles).toHaveBeenCalledTimes(1);
  });

  it('rung 4 retains the pinned Aquifer candidate before a different windowless heuristic', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([other, pinned]));
    vi.mocked(getBibleText).mockImplementation(async ({ aquiferBibleId }) =>
      ok(chapter(aquiferBibleId, windowless))
    );
    expect(await resolve()).toMatchObject({
      provider: 'aquifer',
      verseAddressable: false,
      bible: { aquiferBibleId: 1 },
    });
    expect(getBibleText).toHaveBeenCalledTimes(2);
  });

  it('rung 5 returns honest empty items, not a 404 or an implicit timing signal', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    expect(await resolve()).toMatchObject({
      provider: 'aquifer',
      verseAddressable: false,
      items: [],
      ttsLicenseStatus: 'allowed',
      licenseNotice: 'BSB. Public domain.',
    });
    expect(getBibleText).not.toHaveBeenCalled();
    expect(getBibles).toHaveBeenCalledTimes(1);
  });

  it('a null pin is free: a windowed DBL link returns without an Aquifer catalogue call', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...bible, aquiferBibleId: null }));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track()]));
    expect(await resolve()).toMatchObject({ provider: 'dbl', verseAddressable: true });
    expect(getBibles).not.toHaveBeenCalled();
  });

  it('a null link is free, including when a windowless pin forces the ladder past rung 2', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...bible, externalId: null }));
    vi.mocked(getBibleText).mockResolvedValue(ok(chapter(1, windowless)));
    expect(await resolve()).toMatchObject({ provider: 'aquifer', verseAddressable: false });
    expect(bibleAudioService.getSourceAudio).not.toHaveBeenCalled();
    expect(getBookByCode).not.toHaveBeenCalled();
  });

  it('without either link the heuristic fetches the catalogue once at rung 3', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({ ...bible, aquiferBibleId: null, externalId: null })
    );
    expect(await resolve()).toMatchObject({ provider: 'aquifer', verseAddressable: true });
    expect(getBibles).toHaveBeenCalledTimes(1);
    expect(bibleAudioService.getSourceAudio).not.toHaveBeenCalled();
  });

  it('an unresolvable pin still permits the original heuristic after DBL', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...bible, aquiferBibleId: 999 }));
    expect(await resolve()).toMatchObject({ bible: { aquiferBibleId: 1 }, verseAddressable: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(getBibles).toHaveBeenCalledTimes(1);
    expect(bibleAudioService.getSourceAudio).toHaveBeenCalledTimes(1);
  });
});

describe('verse-addressability guard', () => {
  it('ignores DBL verse zero and nonnumeric ids without changing the valid recording extent', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    const recording = track();
    recording.timecodes!.push(
      { verseId: 'JHN.3.0', start: '0', end: '1' },
      { verseId: 'JHN.3.invalid', start: '0', end: '1' }
    );
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([recording]));
    const result = await resolve();
    expect(result.verseAddressable).toBe(true);
    expect(result.verseTimestamps?.map((v) => v.verse)).toEqual([1, 2, 3]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('negative Aquifer starts cannot pass the guard or leak outside the nonnegative wire schema', async () => {
    vi.mocked(getBibleText).mockResolvedValue(
      ok(
        chapter(1, [
          { ...windows[0]!, audioTimestamp: { start: -1, end: 10 } },
          windows[1]!,
          windows[2]!,
        ])
      )
    );
    const result = await resolve();
    expect(result.verseAddressable).toBe(false);
    expect(result.verseTimestamps?.map((v) => v.verse)).toEqual([2, 3]);
  });

  it('negative DBL starts are missing, not a complete but unseekable recording', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    const recording = track();
    recording.timecodes![0]!.start = '-1';
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([recording]));
    const result = await resolve();
    expect(result.verseAddressable).toBe(false);
    expect(result.verseTimestamps?.map((v) => v.verse)).toEqual([2, 3]);
  });

  it('bounds diagnostics for a corrupt huge DBL verse id instead of allocating to its extent', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([track('corrupt', [Number.MAX_SAFE_INTEGER])])
    );
    expect(await resolve()).toMatchObject({ verseAddressable: false });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({
          missing: Array.from({ length: 100 }, (_, i) => i + 1),
          maxVerse: Number.MAX_SAFE_INTEGER,
        }),
      })
    );
  });

  it('a ragged Aquifer chapter retains its timestamps but cannot claim verse-addressability', async () => {
    vi.mocked(getBibleText).mockResolvedValue(
      ok(chapter(1, [windows[0]!, windowless[1]!, windows[2]!]))
    );
    const result = await resolve();
    expect(result.verseAddressable).toBe(false);
    expect(result.verseTimestamps?.map((v) => v.verse)).toEqual([1, 3]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({ provider: 'aquifer', missing: [2] }),
      })
    );
  });

  it('mid-chapter and last-verse lone starts count: the client closes them without another fetch', async () => {
    vi.mocked(getBibleText).mockResolvedValue(
      ok(
        chapter(1, [
          { number: 1, text: 'v1', audioTimestamp: 0 },
          { number: 2, text: 'v2', audioTimestamp: { start: 10 } },
          { number: 3, text: 'v3', audioTimestamp: { startSeconds: 20 } },
        ])
      )
    );
    const result = await resolve();
    expect(result.verseAddressable).toBe(true);
    expect(result.verseTimestamps).toEqual([
      { verse: 1, startSeconds: 0 },
      { verse: 2, startSeconds: 10 },
      { verse: 3, startSeconds: 20 },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('uses the Aquifer text verse list, not an invented dense count', async () => {
    vi.mocked(getBibleText).mockResolvedValue(ok(chapter(1, [windows[0]!, windows[2]!])));
    expect(await resolve()).toMatchObject({ verseAddressable: true });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(['missing-chapter', 'missing-audio', 'empty-verses', 'hasAudio-false'])(
    '%s cannot pass even if other metadata exists',
    async (condition) => {
      const payload = chapter();
      if (condition === 'missing-chapter') payload.chapters = [];
      if (condition === 'missing-audio') payload.chapters[0]!.audio = null;
      if (condition === 'empty-verses') payload.chapters[0]!.verses = [];
      if (condition === 'hasAudio-false') {
        vi.mocked(getBibles).mockResolvedValue(ok([{ ...pinned, hasAudio: false }]));
      }
      vi.mocked(getBibleText).mockResolvedValue(ok(payload));
      expect(await resolve()).toMatchObject({ verseAddressable: false });
      if (condition === 'hasAudio-false') expect(getBibleText).not.toHaveBeenCalled();
    }
  );

  it('a ragged DBL track retains partial timestamps and warns about the missing start', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track('ragged', [1, 3])]));
    const result = await resolve();
    expect(result).toMatchObject({ provider: 'dbl', verseAddressable: false });
    expect(result.verseTimestamps?.map((v) => v.verse)).toEqual([1, 3]);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        context: expect.objectContaining({ dblAudioBibleId: 'ragged', missing: [2] }),
      })
    );
  });

  it('does not combine complementary partial DBL tracks into a complete recording', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([track('odd', [1, 3]), track('even', [2])])
    );
    const result = await resolve();
    expect(result.verseAddressable).toBe(false);
    expect(result.items.map((v) => v.dblAudioBibleId)).toEqual(['odd', 'even']);
    expect(result.verseTimestamps?.map((v) => v.dblAudioBibleId)).toEqual(['odd', 'odd', 'even']);
  });

  it('the DBL extent includes a last verse whose start could not be parsed', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    const recording = track();
    recording.timecodes![2]!.start = '';
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([recording]));
    expect(await resolve()).toMatchObject({ verseAddressable: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({ missing: [3] }),
      })
    );
  });

  it('the DBL lone starts count even when the provider supplied empty ends', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    const recording = track();
    recording.timecodes?.forEach((v) => {
      v.end = '';
    });
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([recording]));
    const result = await resolve();
    expect(result.verseAddressable).toBe(true);
    expect(result.verseTimestamps?.every((v) => v.endSeconds === undefined)).toBe(true);
  });
});

describe('provider error policy', () => {
  it('a failed pinned recording is not made absent by a heuristic that matches nothing', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({
        ...bible,
        name: 'Local alias',
        abbreviation: 'ALIAS',
        externalId: null,
      })
    );
    const unavailable = err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
    vi.mocked(getBibleText).mockResolvedValue(unavailable);
    expect(await getChapterSourceAudio(input)).toEqual(unavailable);
    expect(getBibleText).toHaveBeenCalledTimes(1);
  });

  it('an unresolvable pin is not a successful lookup when the heuristic recording is unavailable', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({
        ...bible,
        aquiferBibleId: 999,
        externalId: null,
      })
    );
    const unavailable = err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
    vi.mocked(getBibleText).mockResolvedValue(unavailable);
    expect(await getChapterSourceAudio(input)).toEqual(unavailable);
    expect(getBibleText).toHaveBeenCalledTimes(1);
  });

  it('a DBL outage plus a successfully unmatched Aquifer catalogue remains an honest empty', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      err(ErrorCode.DBL_SERVICE_UNAVAILABLE)
    );
    expect(await resolve()).toMatchObject({ verseAddressable: false, items: [] });
  });

  it.each(['catalogue', 'chapter'])(
    'an Aquifer %s unavailable at rung 1 permits windowed DBL',
    async (where) => {
      const unavailable = err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
      if (where === 'catalogue') vi.mocked(getBibles).mockResolvedValue(unavailable);
      else vi.mocked(getBibleText).mockResolvedValue(unavailable);
      vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track()]));
      expect(await resolve()).toMatchObject({ provider: 'dbl', verseAddressable: true });
      expect(logger.warn).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['catalogue', 'chapter'])(
    'both providers unavailable (%s failure) returns the last error, not empty',
    async (where) => {
      if (where === 'catalogue')
        vi.mocked(getBibles).mockResolvedValue(err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE));
      else vi.mocked(getBibleText).mockResolvedValue(err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE));
      const last = err(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(last);
      expect(await getChapterSourceAudio(input)).toEqual(last);
      expect(getBibles).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(getBibleText).toHaveBeenCalledTimes(where === 'chapter' ? 1 : 0);
    }
  );

  it('a complete Aquifer outage without a DBL link is not a false empty', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...bible, externalId: null }));
    const unavailable = err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE);
    vi.mocked(getBibles).mockResolvedValue(unavailable);
    expect(await getChapterSourceAudio(input)).toEqual(unavailable);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a failed pin does not prevent a different heuristic recording from winning', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([other, pinned]));
    vi.mocked(getBibleText).mockImplementation(async ({ aquiferBibleId }) =>
      aquiferBibleId === 1 ? err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE) : ok(chapter(2))
    );
    expect(await resolve()).toMatchObject({ bible: { aquiferBibleId: 2 }, verseAddressable: true });
    expect(getBibles).toHaveBeenCalledTimes(1);
  });

  it('retains windowless DBL if Aquifer is down', async () => {
    vi.mocked(getBibles).mockResolvedValue(err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE));
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([track('dbl', [])]));
    expect(await resolve()).toMatchObject({ provider: 'dbl', verseAddressable: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('a successful empty lookup plus an unavailable provider is not a complete outage', async () => {
    vi.mocked(getBibles).mockResolvedValue(err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE));
    expect(await resolve()).toMatchObject({ items: [], verseAddressable: false });
  });

  it.each(['catalogue', 'chapter', 'dbl', 'bible', 'book'])(
    'a real %s fault still returns immediately',
    async (where) => {
      const fault = err(ErrorCode.INTERNAL_ERROR);
      if (where === 'catalogue') vi.mocked(getBibles).mockResolvedValue(fault);
      if (where === 'chapter') vi.mocked(getBibleText).mockResolvedValue(fault);
      if (where === 'bible') vi.mocked(biblesRepo.getById).mockResolvedValue(fault);
      if (where === 'dbl' || where === 'book') {
        vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...bible, aquiferBibleId: null }));
        if (where === 'dbl') vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(fault);
        else vi.mocked(getBookByCode).mockResolvedValue(fault);
      }
      expect(await getChapterSourceAudio(input)).toEqual(fault);
      expect(logger.warn).not.toHaveBeenCalled();
      if (where === 'bible' || where === 'dbl' || where === 'book')
        expect(getBibles).not.toHaveBeenCalled();
    }
  );
});
