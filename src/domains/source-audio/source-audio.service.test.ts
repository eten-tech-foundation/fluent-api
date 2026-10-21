import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { logger } from '@/lib/logger';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { err, ErrorCode, ok } from '@/lib/types';

import * as sourceAudioRepo from './source-audio.repository';
import {
  getChapterSourceAudio,
  isBibleBookLinkedToProject,
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

vi.mock('./source-audio.repository', () => ({
  isBibleBookLinkedToProject: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const fluentBible: Bible = {
  id: 1,
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageId: 1,
  provider: 'dbl',
  externalId: null,
  audioResourceId: null,
  hasAudio: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('project Bible/book membership', () => {
  it.each([
    ['allows a linked Bible/book', ok(true)],
    ['denies an unrelated Bible/book', ok(false)],
    ['propagates a membership lookup failure', err(ErrorCode.INTERNAL_ERROR)],
  ])('%s', async (_label, expected) => {
    vi.mocked(sourceAudioRepo.isBibleBookLinkedToProject).mockResolvedValue(expected);
    await expect(isBibleBookLinkedToProject(10, 20, 'JHN')).resolves.toEqual(expected);
  });
});

describe('matchAquiferBible', () => {
  it('matches abbreviation, then name, and never language-default/first entry', () => {
    expect(
      matchAquiferBible(fluentBible, [
        { id: 10, name: 'Other Bible', abbreviation: 'OTH' },
        { id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB' },
      ])?.id
    ).toBe(11);
    expect(
      matchAquiferBible(fluentBible, [
        { id: 10, name: 'Berean Standard Bible', abbreviation: 'BER' },
      ])?.id
    ).toBe(10);
    expect(
      matchAquiferBible(fluentBible, [
        { id: 10, name: 'Unrelated', abbreviation: 'X', isLanguageDefault: true },
        { id: 11, name: 'Also unrelated', abbreviation: 'Y' },
      ])
    ).toBeUndefined();
    expect(matchAquiferBible(fluentBible, [])).toBeUndefined();
  });
});

describe('getChapterSourceAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok(fluentBible));
    vi.mocked(getBookByCode).mockResolvedValue(
      ok({ id: 41, code: 'MRK', eng_display_name: 'Mark', updatedAt: null })
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
          timecodes: [
            { start: '00:00:00.000', end: '00:00:01.500', verseId: 'MRK.14.1' },
            { start: '00:00:05.120', end: '00:00:09.000', verseId: 'MRK.14.2' },
          ],
        },
        {
          audioBibleId: 'audio-2',
          name: 'Alternate Audio',
          chapterId: 'MRK.14',
          resourceUrl: 'https://example.com/alternate.mp3',
          expiresAt: null,
          // Decimal-second fixture shape still accepted.
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
        { verse: 1, startSeconds: 0, dblAudioBibleId: 'audio-1' },
        { verse: 2, startSeconds: 5.12, dblAudioBibleId: 'audio-1' },
        { verse: 1, startSeconds: 9, dblAudioBibleId: 'audio-2' },
      ]);
      expect(result.data.bible.dblAudioBibleId).toBe('audio-1');
      expect(result.data.bible.abbreviation).toBe('BSB');
    }
    expect(getBibles).not.toHaveBeenCalled();
  });

  it.each<[string, { start: string; end: string; verseId: string }[] | null, boolean]>([
    ['null', null, false],
    ['empty', [], false],
    [
      'unparseable/wrong-chapter',
      [
        { start: 'not-a-time', end: '00:00:01.000', verseId: 'MRK.14.1' },
        { start: '00:00:05.000', end: '00:00:06.000', verseId: 'JHN.4.1' },
        { start: 'bad', end: 'bad', verseId: 'MRK.14.x' },
      ],
      true,
    ],
  ])(
    'omits verseTimestamps when DBL timecodes are %s',
    async (_label, timecodes, expectDropWarning) => {
      vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
        ok([
          {
            audioBibleId: 'audio-1',
            name: 'BSB Audio',
            chapterId: 'MRK.14',
            resourceUrl: 'https://example.com/audio.mp3',
            expiresAt: null,
            timecodes,
          },
        ])
      );
      const result = await getChapterSourceAudio({
        languageCode: 'eng',
        fluentBibleId: 1,
        bookCode: 'MRK',
        chapter: 14,
      });
      expect(result).toMatchObject({ ok: true, data: { items: [{ dblAudioBibleId: 'audio-1' }] } });
      if (result.ok) expect(result.data.verseTimestamps).toBeUndefined();
      if (expectDropWarning) {
        expect(logger.warn).toHaveBeenCalledWith({
          message: 'All DBL timecodes dropped by shared parser',
          context: expect.objectContaining({
            path: 'source-audio',
            audioBibleId: 'audio-1',
            chapter: 'MRK.14',
            timecodeCount: 3,
            samples: [
              { start: 'aaa-a-aaaa', end: '99:99:99.999', verseId: 'AAA.99.9' },
              { start: '99:99:99.999', end: '99:99:99.999', verseId: 'AAA.9.9' },
              { start: 'aaa', end: 'aaa', verseId: 'AAA.99.a' },
            ],
          }),
        });
        const emittedPayload = vi.mocked(logger.warn).mock.calls[0]?.[0];
        const emitted = JSON.stringify(emittedPayload);
        expect(emitted).not.toContain('not-a-time');
        expect(emitted).not.toContain('JHN.4.1');
        expect(emitted).not.toContain('MRK.14.x');
        expect(emitted).not.toContain('MRK.14.1');
        expect(emitted).not.toMatch(/https?:\/\/example/i);
        expect(emitted).not.toContain('eyJhbGci');
      } else {
        expect(logger.warn).not.toHaveBeenCalled();
      }
    }
  );

  it('emits format-only shapes for rejected source-audio warn samples', async () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abc123';
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'audio-1',
          name: 'BSB Audio',
          chapterId: 'MRK.14',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: null,
          timecodes: [
            { start: '00:00:05.000', end: '00:00:06.000', verseId: jwt },
            { start: 'not-a-time', end: '1', verseId: 'MRK.14.1' },
          ],
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
    if (result.ok) expect(result.data.verseTimestamps).toBeUndefined();
    const payload = vi.mocked(logger.warn).mock.calls[0]?.[0];
    expect(payload).toEqual({
      message: 'All DBL timecodes dropped by shared parser',
      context: {
        path: 'source-audio',
        audioBibleId: 'audio-1',
        chapter: 'MRK.14',
        timecodeCount: 2,
        samples: [
          {
            start: '99:99:99.999',
            end: '99:99:99.999',
            verseId: 'aaAaaAaaAaAAAaA9AaAaAaA9aAA9AaaA…',
          },
          { start: 'aaa-a-aaaa', end: '9', verseId: 'AAA.99.9' },
        ],
      },
    });
    const emitted = JSON.stringify(payload);
    expect(emitted).not.toContain(jwt);
    expect(emitted).not.toContain('not-a-time');
    expect(emitted).not.toContain('MRK.14.1');
    expect(emitted).not.toContain('example.com');
  });

  it('does not warn when at least one DBL timecode is accepted', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'audio-1',
          name: 'BSB Audio',
          chapterId: 'MRK.14',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: null,
          timecodes: [
            { start: 'not-a-time', end: '1', verseId: 'MRK.14.1' },
            { start: '5.0', end: '9.0', verseId: 'MRK.14.2' },
          ],
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
      expect(result.data.verseTimestamps).toEqual([
        { verse: 2, startSeconds: 5, dblAudioBibleId: 'audio-1' },
      ]);
    }
    expect(logger.warn).not.toHaveBeenCalled();
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

describe('legacy source and manifest isolation from explicit playback selections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...fluentBible, audioResourceId: 999 }));
    vi.mocked(getBookByCode).mockResolvedValue(
      ok({ id: 41, code: 'MRK', eng_display_name: 'Mark', updatedAt: null })
    );
  });

  it('keeps linked windowless DBL ahead of Aquifer despite a selected recording FK', async () => {
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'linked-audio',
          chapterId: 'MRK.14',
          expiresAt: null,
          name: 'DBL',
          resourceUrl: 'https://example.com/dbl.mp3',
        },
      ])
    );
    const result = await getChapterSourceAudio({
      bookCode: 'MRK',
      chapter: 14,
      fluentBibleId: 1,
      languageCode: 'eng',
    });
    expect(result).toMatchObject({
      ok: true,
      data: { provider: 'dbl', items: [{ dblAudioBibleId: 'linked-audio' }] },
    });
    expect(getBibles).not.toHaveBeenCalled();
    if (result.ok) {
      expect(result.data).not.toHaveProperty('ttsLicenseStatus');
      expect(result.data).not.toHaveProperty('selectedRecordingKey');
      expect(result.data).not.toHaveProperty('verseAddressable');
    }
  });
});
