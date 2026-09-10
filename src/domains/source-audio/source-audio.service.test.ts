import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';
import type { AquiferBible } from '@/lib/services/aquifer/aquifer.types';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';

import {
  getChapterSourceAudio,
  getSourceAudioManifest,
  matchAquiferBible,
} from './source-audio.service';

vi.mock('@/domains/bibles/bibles.repository', () => ({
  getById: vi.fn(),
}));

vi.mock('@/domains/books/books.service', () => ({
  getBookByCode: vi.fn(),
}));

vi.mock('@/domains/bibles/bible-audio/bible-audio.service', () => ({
  getSourceAudio: vi.fn(),
}));

vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getBibles: vi.fn(),
  getBibleText: vi.fn(),
}));

const fluentBible: Bible = {
  id: 1,
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageId: 1,
  provider: 'dbl',
  externalId: null,
  hasAudio: false,
  aquiferBibleId: null,
  ttsLicenseStatus: 'unknown',
  licenseNotice: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('matchAquiferBible', () => {
  it('prefers abbreviation match', () => {
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Other Bible', abbreviation: 'OTH' },
      { id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' },
    ];
    expect(matchAquiferBible(fluentBible, candidates)?.id).toBe(11);
  });

  it('falls back to name match', () => {
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Berean Standard Bible', abbreviation: 'BER' },
    ];
    expect(matchAquiferBible(fluentBible, candidates)?.id).toBe(10);
  });

  it('does not fall through to a language default or first catalogue entry', () => {
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Unrelated', abbreviation: 'X', isLanguageDefault: true },
      { id: 11, name: 'Also unrelated', abbreviation: 'Y' },
    ];
    expect(matchAquiferBible(fluentBible, candidates)).toBeUndefined();
  });

  it('returns undefined when no candidates', () => {
    expect(matchAquiferBible(fluentBible, [])).toBeUndefined();
  });

  it('prefers a pinned aquiferBibleId over any name or abbreviation match', () => {
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Berean Standard Bible', abbreviation: 'BSB' },
      { id: 11, name: 'Something Else', abbreviation: 'ELS' },
    ];
    // The heuristic would pick 10 on both abbreviation AND name; the peg wins anyway.
    expect(matchAquiferBible({ ...fluentBible, aquiferBibleId: 11 }, candidates)?.id).toBe(11);
  });

  it('pins across a same-abbreviation collision, which is what the column is for', () => {
    // Aquifer really does ship two Bibles abbreviated IRV (id 2 Hindi, id 27 Gujarati). The
    // heuristic takes whichever is first; the peg makes the choice explicit.
    const candidates: AquiferBible[] = [
      { id: 2, name: 'Indian Revised Version', abbreviation: 'IRV' },
      { id: 27, name: 'Indian Revised Version - Gujarati', abbreviation: 'IRV' },
    ];
    const irv = { ...fluentBible, name: 'IRV Gujarati', abbreviation: 'IRV' };

    expect(matchAquiferBible(irv, candidates)?.id).toBe(2);
    expect(matchAquiferBible({ ...irv, aquiferBibleId: 27 }, candidates)?.id).toBe(27);
  });

  it('falls back to the heuristic when a pinned id is not in the catalogue', () => {
    // Deliberately additive: a set-but-unresolvable peg must not change the answer a row
    // would have got before the column existed.
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Berean Standard Bible', abbreviation: 'BSB' },
    ];
    expect(matchAquiferBible({ ...fluentBible, aquiferBibleId: 999 }, candidates)?.id).toBe(10);
  });

  it('behaves identically to the pre-column code when the peg is null', () => {
    const candidates: AquiferBible[] = [
      { id: 10, name: 'Berean Standard Bible', abbreviation: 'BSB' },
    ];
    expect(matchAquiferBible({ ...fluentBible, aquiferBibleId: null }, candidates)?.id).toBe(
      matchAquiferBible(fluentBible, candidates)?.id
    );
  });
});

describe('getChapterSourceAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok(fluentBible));
    vi.mocked(getBookByCode).mockResolvedValue(
      ok({ id: 41, code: 'MRK', eng_display_name: 'Mark' })
    );
  });

  it('returns DBL tracks when available', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'audio-1',
          name: 'BSB Audio',
          chapterId: 'MRK.14',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: 123,
          timecodes: [{ start: '0.0', end: '1.5', verseId: 'MRK.14.1' }],
        },
        {
          audioBibleId: 'audio-2',
          name: 'Alternate Audio',
          chapterId: 'MRK.14',
          resourceUrl: 'https://example.com/alternate.mp3',
          expiresAt: null,
          timecodes: [{ start: '9.0', end: '12.0', verseId: 'MRK.14.1' }],
        },
      ])
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.provider).toBe('dbl');
      expect(result.data.items).toHaveLength(2);
      expect(result.data.items[0]?.url).toBe('https://example.com/audio.mp3');
      expect(result.data.items[0]?.dblAudioBibleId).toBe('audio-1');
      expect(result.data.items[1]?.dblAudioBibleId).toBe('audio-2');
      expect(result.data.items[0]).not.toHaveProperty('sizeBytes');
      expect(result.data.verseTimestamps).toEqual([
        { verse: 1, startSeconds: 0, endSeconds: 1.5, dblAudioBibleId: 'audio-1' },
        { verse: 1, startSeconds: 9, endSeconds: 12, dblAudioBibleId: 'audio-2' },
      ]);
      expect(result.data.bible.dblAudioBibleId).toBe('audio-1');
      expect(result.data.bible.abbreviation).toBe('BSB');
    }
    expect(getBibles).not.toHaveBeenCalled();
  });

  it('publishes the per-verse window Aquifer supplies, last verse included', async () => {
    // Shape and values taken from a real response, 2026-08-31:
    // GET /bibles/1/texts?BookCode=JHN&StartChapter=3&EndChapter=3&shouldReturnAudioData=true
    // Every verse carried a window and each verse's end was the next verse's start.
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 1, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 1,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'John',
        bookCode: 'JHN',
        chapters: [
          {
            number: 3,
            audio: { mp3: { url: 'https://cdn.example/jhn3.mp3', size: 1251337 } },
            verses: [
              { number: 1, text: 'v1', audioTimestamp: { start: 4.52, end: 10.32 } },
              { number: 2, text: 'v2', audioTimestamp: { start: 10.32, end: 23.36 } },
              { number: 36, text: 'v36', audioTimestamp: { start: 300.52, end: 312.73 } },
            ],
          },
        ],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'JHN',
      chapter: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verseTimestamps).toEqual([
        { verse: 1, startSeconds: 4.52, endSeconds: 10.32 },
        { verse: 2, startSeconds: 10.32, endSeconds: 23.36 },
        { verse: 36, startSeconds: 300.52, endSeconds: 312.73 },
      ]);
    }
  });

  it('keeps a verse whose start has no end, rather than dropping it', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 1, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 1,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'John',
        bookCode: 'JHN',
        chapters: [
          {
            number: 3,
            audio: { mp3: { url: 'https://cdn.example/jhn3.mp3', size: 1 } },
            verses: [
              // A bare number kept its old meaning: a start with no end.
              { number: 1, text: 'v1', audioTimestamp: 4.52 },
              { number: 2, text: 'v2' },
            ],
          },
        ],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'JHN',
      chapter: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verseTimestamps).toEqual([{ verse: 1, startSeconds: 4.52 }]);
    }
  });

  it('reads DBL timecodes as clock time when they are not plain decimals', async () => {
    // UNPROVEN AGAINST LIVE DATA, and deliberately so: a sweep of all 355 audio Bibles the
    // configured key can reach (2026-08-31) found `timecodes` on none of them, and the
    // contract does not document the format. `Number.parseFloat('00:01:23.4')` would return 0.
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'audio-1',
          name: 'Some Audio Bible',
          chapterId: 'JHN.3',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: null,
          timecodes: [{ start: '00:01:23.4', end: '00:01:30', verseId: 'JHN.3.16' }],
        },
      ])
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'JHN',
      chapter: 3,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.verseTimestamps).toEqual([
        { verse: 16, startSeconds: 83.4, endSeconds: 90, dblAudioBibleId: 'audio-1' },
      ]);
    }
  });

  it('falls back to Aquifer when DBL has no tracks', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 11,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [
          {
            number: 14,
            audio: { mp3: { url: 'https://cdn.example/a.mp3', size: 99 } },
            verses: [{ number: 1, text: 'Hello' }],
          },
        ],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.provider).toBe('aquifer');
      expect(result.data.items).toEqual([
        {
          format: 'mp3',
          url: 'https://cdn.example/a.mp3',
          sizeBytes: 99,
          scope: 'chapter',
        },
      ]);
    }
  });

  it('returns empty items when neither provider has audio', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 11,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [{ number: 14, verses: [{ number: 1, text: 'Hello' }] }],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
    }
  });

  it('keeps Aquifer audio playable when the provider omits its size', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 11,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [
          {
            number: 14,
            audio: { mp3: { url: 'https://cdn.example/a.mp3' } },
            verses: [{ number: 1, text: null }],
          },
        ],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([
        {
          format: 'mp3',
          url: 'https://cdn.example/a.mp3',
          scope: 'chapter',
        },
      ]);
    }
  });

  it('returns empty items when Aquifer has no matching bible', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(ok([]));

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.provider).toBe('aquifer');
      expect(result.data.items).toEqual([]);
    }
    expect(getBibleText).not.toHaveBeenCalled();
  });

  it('falls back to Aquifer when DBL is unavailable', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      err(ErrorCode.DBL_SERVICE_UNAVAILABLE)
    );
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' }])
    );
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 11,
        bibleName: 'Berean Standard Bible',
        bibleAbbreviation: 'BSB',
        bookName: 'Mark',
        bookCode: 'MRK',
        chapters: [
          {
            number: 14,
            audio: { mp3: { url: 'https://cdn.example/a.mp3', size: 99 } },
            verses: [{ number: 1, text: 'Hello' }],
          },
        ],
      })
    );

    const result = await getChapterSourceAudio({
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      chapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.provider).toBe('aquifer');
      expect(result.data.items[0]?.url).toBe('https://cdn.example/a.mp3');
    }
  });
});

describe('getSourceAudioManifest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok(fluentBible));
  });

  it('returns empty items when no Aquifer bible matches', async () => {
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 10, name: 'Unrelated', abbreviation: 'X', isLanguageDefault: true }])
    );

    const result = await getSourceAudioManifest({
      projectId: 10,
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      startChapter: 14,
      endChapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.totalBytes).toBe(0);
    }
    expect(getBibleText).not.toHaveBeenCalled();
  });

  it('does not fall through to a sibling edition when the exact match has no audio', async () => {
    vi.mocked(getBibles).mockResolvedValue(
      ok([
        {
          id: 11,
          name: 'Berean Standard Bible',
          abbreviation: 'BSB',
          hasAudio: false,
        },
        { id: 12, name: 'Sibling Edition', abbreviation: 'SIB', hasAudio: true },
      ])
    );

    const result = await getSourceAudioManifest({
      projectId: 10,
      languageCode: 'eng',
      fluentBibleId: 1,
      bookCode: 'MRK',
      startChapter: 14,
      endChapter: 14,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
    }
    expect(getBibleText).not.toHaveBeenCalled();
  });
});
