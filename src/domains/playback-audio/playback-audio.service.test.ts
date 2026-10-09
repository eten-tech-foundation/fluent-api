import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DblBible, DblVerseListItem } from '@/lib/services/dbl/dbl.types';

import * as resources from '@/domains/bible-provider-resources/bible-provider-resources.service';
import { getBibleRecordById } from '@/domains/bibles/bibles.service';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { err, ErrorCode, ok } from '@/lib/types';

import { getSourceChapterVerseNumbers } from './playback-audio.repository';
import {
  getReferencePlayback,
  getResourceFacts,
  getSourcePlayback,
  parseDblTimestampSeconds,
} from './playback-audio.service';

vi.mock('@/domains/bible-provider-resources/bible-provider-resources.service', () => ({
  getById: vi.fn(),
  getByProviderIdentity: vi.fn(),
}));
vi.mock('@/domains/bibles/bibles.service', () => ({ getBibleRecordById: vi.fn() }));
vi.mock('@/lib/services/aquifer/aquifer.client', () => ({
  getBibles: vi.fn(),
  getBibleText: vi.fn(),
}));
vi.mock('@/lib/services/dbl/dbl.client', () => ({
  dblClient: { getBible: vi.fn(), getAudioChapter: vi.fn(), getVerses: vi.fn() },
}));
vi.mock('./playback-audio.repository', () => ({ getSourceChapterVerseNumbers: vi.fn() }));
const input = { languageCode: 'eng', bookCode: 'JHN' as const, chapter: 3 };
const text = { provider: 'dbl' as const, externalId: 'text-id' };
const recording = {
  id: 11,
  provider: 'aquifer' as const,
  externalId: '1',
  ttsLicenseStatus: 'allowed' as const,
  licenseNotice: 'Recording notice',
  displayName: null,
};
const source = {
  id: 1,
  languageId: 1,
  name: 'BSB',
  abbreviation: 'BSB',
  ...text,
  audioResourceId: 11,
  hasAudio: true,
  createdAt: null,
  updatedAt: null,
};
const catalogue = [{ id: 1, name: 'BSB', abbreviation: 'BSB', hasAudio: true }];
const chapter = {
  number: 3,
  verses: [
    { number: 1, text: 'First', audioTimestamp: { start: 0, end: 4 } },
    { number: 2, text: 'Second', audioTimestamp: { start: 4, end: 8 } },
  ],
  audio: {
    mp3: { url: 'https://example.com/chapter.mp3', size: 20 },
    webm: { url: 'https://example.com/chapter.webm', size: 15 },
  },
};
const aquiferText = {
  bibleId: 1,
  bibleName: 'BSB',
  bibleAbbreviation: 'BSB',
  bookCode: 'JHN',
  bookName: 'John',
  chapters: [chapter],
};
const dblVerses = [{ id: 'JHN.3.1' }, { id: 'JHN.3.2' }] satisfies DblVerseListItem[];
const dblBible = {
  id: 'text-id',
  abbreviation: 'BSB',
  abbreviationLocal: 'BSB',
  language: {
    id: 'eng',
    name: 'English',
    nameLocal: 'English',
    script: 'Latin',
    scriptDirection: 'LTR',
  },
  countries: [],
  name: 'BSB',
  nameLocal: 'BSB',
  description: null,
  descriptionLocal: null,
  relatedDbl: null,
  type: 'text',
  updatedAt: null,
  audioBibles: [
    { id: 'audio-a', name: 'A', nameLocal: 'A' },
    { id: 'audio-b', name: 'B', nameLocal: 'B' },
  ],
  copyright: null,
  info: null,
} satisfies DblBible;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getBibleRecordById).mockResolvedValue(ok(source));
  vi.mocked(resources.getById).mockResolvedValue(ok(recording));
  vi.mocked(resources.getByProviderIdentity).mockImplementation(async (provider, externalId) =>
    ok(provider === 'aquifer' && externalId === '1' ? recording : null)
  );
  vi.mocked(getBibles).mockResolvedValue(ok(catalogue));
  vi.mocked(getBibleText).mockResolvedValue(ok(aquiferText));
  vi.mocked(getSourceChapterVerseNumbers).mockResolvedValue(ok([1, 2]));
  vi.mocked(dblClient.getVerses).mockResolvedValue(ok(dblVerses));
});

describe('explicit playback identities and policy', () => {
  it('uses selected recording without borrowing its allowed text policy', async () => {
    const result = await getSourcePlayback({ ...input, fluentBibleId: 1 });
    expect(result).toMatchObject({
      ok: true,
      data: {
        textBibleKey: 'dbl-text-id',
        selectedRecordingKey: 'aq-1',
        ttsLicenseStatus: 'unknown',
        verseAddressable: true,
        items: [
          { recordingKey: 'aq-1', licenseNotice: 'Recording notice' },
          { recordingKey: 'aq-1', licenseNotice: 'Recording notice' },
        ],
        verseTimestamps: [
          { verse: 1, startSeconds: 0, endSeconds: 4 },
          { verse: 2, startSeconds: 4, endSeconds: 8 },
        ],
      },
    });
    expect(dblClient.getBible).not.toHaveBeenCalled();
  });
  it('reference recording works without a source or resource row and never writes', async () => {
    vi.mocked(resources.getByProviderIdentity).mockResolvedValue(ok(null));
    expect(
      await getReferencePlayback({ ...input, identity: { provider: 'aquifer', externalId: '1' } })
    ).toMatchObject({
      ok: true,
      data: {
        ttsLicenseStatus: 'unknown',
        items: [{ licenseNotice: null }, { licenseNotice: null }],
      },
    });
    expect(getBibleRecordById).not.toHaveBeenCalled();
  });
  it('missing facts are successful unknown; database failure is an error', async () => {
    expect(await getResourceFacts(text)).toMatchObject({
      ok: true,
      data: { id: null, ttsLicenseStatus: 'unknown', licenseNotice: null },
    });
    vi.mocked(resources.getByProviderIdentity).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toEqual(
      err(ErrorCode.INTERNAL_ERROR)
    );
    expect(getBibles).not.toHaveBeenCalled();
  });
  it('does not name-match a selected missing identity, and enforces language catalogue membership', async () => {
    vi.mocked(getBibles).mockResolvedValue(ok([{ ...catalogue[0], id: 2 }]));
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toEqual(
      err(ErrorCode.BIBLE_NOT_FOUND)
    );
    expect(getBibleText).not.toHaveBeenCalled();
    expect(dblClient.getBible).not.toHaveBeenCalled();
  });
  it('propagates media errors while independent permission lookup remains available', async () => {
    vi.mocked(getBibleText).mockResolvedValue(err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE));
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toEqual(
      err(ErrorCode.AQUIFER_SERVICE_UNAVAILABLE)
    );
    expect(await getResourceFacts(recording)).toMatchObject({
      ok: true,
      data: { ttsLicenseStatus: 'allowed' },
    });
  });
  it('labels incomplete timing windowless, without trying another provider', async () => {
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        ...aquiferText,
        chapters: [
          {
            ...chapter,
            verses: [{ ...chapter.verses[0], audioTimestamp: null }, chapter.verses[1]],
          },
        ],
      })
    );
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
    expect(dblClient.getBible).not.toHaveBeenCalled();
  });
  it('judges Aquifer source timings against the drafted chapter verse numbers', async () => {
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        ...aquiferText,
        chapters: [
          {
            ...chapter,
            verses: [
              chapter.verses[0],
              chapter.verses[1],
              { number: 4, text: 'Fourth', audioTimestamp: { start: 8, end: 12 } },
            ],
          },
        ],
      })
    );
    vi.mocked(getSourceChapterVerseNumbers).mockResolvedValue(ok([1, 3, 4]));

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
    expect(
      await getReferencePlayback({
        ...input,
        identity: { provider: 'aquifer', externalId: '1' },
      })
    ).toMatchObject({ ok: true, data: { verseAddressable: true } });
  });
  it('defers YouVersion recording but returns independent clearance', async () => {
    expect(
      await getReferencePlayback({
        ...input,
        identity: { provider: 'youversion', externalId: '100' },
      })
    ).toMatchObject({
      ok: true,
      data: {
        provider: 'youversion',
        textBibleKey: 'yv-100',
        items: [],
        ttsLicenseStatus: 'unknown',
      },
    });
    expect(getBibles).not.toHaveBeenCalled();
  });
  it('allows a selected recording when source text has no external identity', async () => {
    vi.mocked(getBibleRecordById).mockResolvedValue(ok({ ...source, externalId: null }));
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { textBibleKey: null, ttsLicenseStatus: 'unknown', selectedRecordingKey: 'aq-1' },
    });
  });
});

describe('dBL actual audio identity and timing', () => {
  beforeEach(() => {
    vi.mocked(getBibleRecordById).mockResolvedValue(ok({ ...source, audioResourceId: null }));
    vi.mocked(dblClient.getBible).mockResolvedValue(ok(dblBible));
    vi.mocked(dblClient.getAudioChapter).mockImplementation(async (id) =>
      ok({
        id: 'JHN.3',
        resourceUrl: `https://example.com/${id}.mp3`,
        timecodes: [
          { verseId: 'JHN.3.1', start: '00:00.0', end: '00:04.5' },
          { verseId: 'JHN.3.2', start: '4.5', end: '9' },
        ],
      })
    );
    vi.mocked(resources.getByProviderIdentity).mockImplementation(async (provider, externalId) =>
      ok({
        ...recording,
        provider,
        externalId,
        licenseNotice: externalId,
        ttsLicenseStatus: externalId === 'text-id' ? 'forbidden' : 'allowed',
      })
    );
  });
  it('default follows linked audio tracks with individual notices and timestamps', async () => {
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: {
        ttsLicenseStatus: 'forbidden',
        verseAddressable: true,
        items: [
          { recordingKey: 'dbl-audio-a', licenseNotice: 'audio-a', trackId: 'JHN.3' },
          { recordingKey: 'dbl-audio-b', licenseNotice: 'audio-b' },
        ],
        verseTimestamps: [
          { verse: 1, startSeconds: 0, endSeconds: 4.5, dblAudioBibleId: 'audio-a' },
          { verse: 2, dblAudioBibleId: 'audio-a' },
          { verse: 1, dblAudioBibleId: 'audio-b' },
          { verse: 2, dblAudioBibleId: 'audio-b' },
        ],
      },
    });
    expect(dblClient.getBible).toHaveBeenCalledWith('text-id');
    expect(getSourceChapterVerseNumbers).toHaveBeenCalledWith(1, 'JHN', 3);
    expect(dblClient.getVerses).not.toHaveBeenCalled();
    expect(getBibles).not.toHaveBeenCalled();
  });
  it('selected DBL resource dispatches directly to audio chapter, never as text', async () => {
    vi.mocked(getBibleRecordById).mockResolvedValue(ok(source));
    vi.mocked(resources.getById).mockResolvedValue(
      ok({ ...recording, provider: 'dbl', externalId: 'audio-b' })
    );
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { selectedRecordingKey: 'dbl-audio-b', items: [{ recordingKey: 'dbl-audio-b' }] },
    });
    expect(dblClient.getBible).not.toHaveBeenCalled();
    expect(dblClient.getAudioChapter).toHaveBeenCalledWith('audio-b', 'JHN.3');
  });
  it('skips only typed missing DBL audio chapters', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
      ok: false,
      error: {
        code: ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND,
        message: 'DBL audio chapter not found',
      },
    });

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { items: [], verseAddressable: false },
    });
  });
  it('keeps an available DBL track when another linked track is missing', async () => {
    vi.mocked(dblClient.getAudioChapter).mockImplementation(async (id) =>
      id === 'audio-a'
        ? {
            ok: false,
            error: {
              code: ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND,
              message: 'DBL audio chapter not found',
            },
          }
        : ok({
            id: 'JHN.3',
            resourceUrl: 'https://example.com/audio-b.mp3',
            timecodes: [
              { verseId: 'JHN.3.1', start: '0', end: '4' },
              { verseId: 'JHN.3.2', start: '4', end: '8' },
            ],
          })
    );

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: {
        verseAddressable: true,
        items: [{ recordingKey: 'dbl-audio-b' }],
      },
    });
  });
  it('propagates DBL provider failures even when their message mentions 404', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
      ok: false,
      error: {
        code: ErrorCode.DBL_SERVICE_UNAVAILABLE,
        message: 'malformed response mentioning 404',
      },
    });

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: false,
      error: { code: ErrorCode.DBL_SERVICE_UNAVAILABLE },
    });
  });
  it.each(['', '1wrong', '1:99', '-1', 'Infinity', '1::2'])(
    'rejects malformed timecode %s',
    (value) => expect(parseDblTimestampSeconds(value)).toBeUndefined()
  );
  it('ignores wrong-chapter timing and keeps windowless tracks labelled', async () => {
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue(
      ok({
        id: 'JHN.3',
        resourceUrl: 'https://example.com/a.mp3',
        timecodes: [{ verseId: 'JHN.4.1', start: '0', end: '4' }],
      })
    );
    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
    expect(getSourceChapterVerseNumbers).not.toHaveBeenCalled();
  });

  it('does not call a timecoded prefix a complete source chapter', async () => {
    vi.mocked(getSourceChapterVerseNumbers).mockResolvedValue(ok([1, 2, 3]));

    const result = await getSourcePlayback({ ...input, fluentBibleId: 1 });
    expect(result).toMatchObject({ ok: true, data: { verseAddressable: false } });
    if (result.ok) expect(result.data.verseTimestamps).toHaveLength(4);
  });

  it('judges the track selected by the browser, not another complete track', async () => {
    vi.mocked(dblClient.getAudioChapter).mockImplementation(async (id) =>
      ok({
        id: 'JHN.3',
        resourceUrl: `https://example.com/${id}.mp3`,
        timecodes:
          id === 'audio-a'
            ? [{ verseId: 'JHN.3.1', start: '0', end: '4' }]
            : [
                { verseId: 'JHN.3.1', start: '0', end: '4' },
                { verseId: 'JHN.3.2', start: '4', end: '8' },
              ],
      })
    );

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
  });

  it('uses the DBL text chapter verse list for references', async () => {
    vi.mocked(dblClient.getVerses).mockResolvedValue(
      ok([{ id: 'JHN.3.1' }, { id: 'JHN.3.2' }, { id: 'JHN.3.3' }] satisfies DblVerseListItem[])
    );

    expect(await getReferencePlayback({ ...input, identity: text })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
    expect(dblClient.getVerses).toHaveBeenCalledWith('text-id', 'JHN.3');
    expect(getSourceChapterVerseNumbers).not.toHaveBeenCalled();
  });

  it('propagates a failed local source chapter count instead of claiming absent windows', async () => {
    vi.mocked(getSourceChapterVerseNumbers).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toEqual(
      err(ErrorCode.INTERNAL_ERROR)
    );
  });

  it('treats a confirmed empty source chapter as windowless', async () => {
    vi.mocked(getSourceChapterVerseNumbers).mockResolvedValue(ok([]));

    expect(await getSourcePlayback({ ...input, fluentBibleId: 1 })).toMatchObject({
      ok: true,
      data: { verseAddressable: false },
    });
  });

  it('propagates a failed DBL reference verse list lookup', async () => {
    vi.mocked(dblClient.getVerses).mockResolvedValue(err(ErrorCode.DBL_SERVICE_UNAVAILABLE));

    expect(await getReferencePlayback({ ...input, identity: text })).toEqual(
      err(ErrorCode.DBL_SERVICE_UNAVAILABLE)
    );
  });
});
