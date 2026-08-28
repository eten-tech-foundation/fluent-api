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
      expect(result.data.verseTimestamps).toEqual([{ verse: 1, startSeconds: 0 }]);
      expect(result.data.bible.dblAudioBibleId).toBe('audio-1');
    }
    expect(getBibles).not.toHaveBeenCalled();
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
});
