import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';

import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { ok } from '@/lib/types';

import { getSourceAudioManifest } from './source-audio.service';

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

describe('legacy source and manifest isolation from explicit playback selections', () => {
  it('manifest still name-matches and retains download metadata while omitting unknown sizes', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ ...fluentBible, audioResourceId: 999 }));
    vi.mocked(getBibles).mockResolvedValue(
      ok([{ id: 11, name: 'Berean Standard Bible', abbreviation: 'BSB', hasAudio: true }])
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
            audio: {
              mp3: { url: 'https://example.com/a.mp3', size: 99 },
              webm: { url: 'https://example.com/a.webm' },
            },
            verses: [],
          },
        ],
      })
    );
    expect(
      await getSourceAudioManifest({
        projectId: 10,
        fluentBibleId: 1,
        languageCode: 'eng',
        bookCode: 'MRK',
        startChapter: 14,
        endChapter: 14,
      })
    ).toEqual(
      ok({
        projectId: 10,
        sourceLanguageCode: 'eng',
        provider: 'aquifer',
        totalBytes: 99,
        items: [
          {
            id: 'source-audio-11-MRK-14-mp3',
            tier: 1,
            kind: 'audio',
            resourceName: 'Source Bible Audio',
            label: 'BSB MRK 14 (mp3)',
            required: true,
            removable: false,
            bytesTotal: 99,
            sourceUrl: 'https://example.com/a.mp3',
            fileExt: 'mp3',
            languageCode: 'eng',
            bookCode: 'MRK',
            startChapter: 14,
            endChapter: 14,
            format: 'mp3',
            aquiferBibleId: 11,
          },
        ],
      })
    );
    expect(getBibleText).toHaveBeenCalledWith({
      aquiferBibleId: 11,
      bookCode: 'MRK',
      startChapter: 14,
      endChapter: 14,
      includeAudio: true,
    });
  });
});
