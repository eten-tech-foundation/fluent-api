import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';

import * as bibleAudioService from '@/domains/bibles/bible-audio/bible-audio.service';
import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { getBibles, getBibleText } from '@/lib/services/aquifer/aquifer.client';
import { ok } from '@/lib/types';

import { getChapterSourceAudio } from './source-audio.service';

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
  aquiferBibleId: null,
  ttsLicenseStatus: 'unknown',
  licenseNotice: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('source audio licence facts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getBibles).mockResolvedValue(ok([]));
    vi.mocked(biblesRepo.getById).mockResolvedValue(ok(fluentBible));
    vi.mocked(getBookByCode).mockResolvedValue(
      ok({ id: 41, code: 'MRK', eng_display_name: 'Mark' })
    );
  });

  it.each(['allowed', 'forbidden', 'unknown'] as const)(
    'joins the requested Bible licence (%s) even when Aquifer has no audio',
    async (ttsLicenseStatus) => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(
        ok({
          ...fluentBible,
          aquiferBibleId: 1,
          ttsLicenseStatus,
          licenseNotice: 'Curated text notice',
        })
      );
      vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
      vi.mocked(getBibles).mockResolvedValue(ok([]));
      const result = await getChapterSourceAudio({
        fluentBibleId: 1,
        languageCode: 'eng',
        bookCode: 'JHN',
        chapter: 3,
      });
      expect(result).toMatchObject({
        ok: true,
        data: {
          ttsLicenseStatus,
          licenseNotice: 'Curated text notice',
          items: [],
        },
      });
    }
  );

  it('joins licence facts onto pinned Aquifer audio without inferring rights from the recording', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({
        ...fluentBible,
        aquiferBibleId: 1,
        ttsLicenseStatus: 'allowed',
        licenseNotice: 'BSB. Public domain.',
      })
    );
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(ok([]));
    vi.mocked(getBibles).mockResolvedValue(ok([{ id: 1, name: 'BSB', abbreviation: 'BSB' }]));
    vi.mocked(getBibleText).mockResolvedValue(
      ok({
        bibleId: 1,
        bibleName: 'BSB',
        bibleAbbreviation: 'BSB',
        bookName: 'John',
        bookCode: 'JHN',
        chapters: [
          { number: 3, verses: [], audio: { mp3: { url: 'https://example.com/jhn3.mp3' } } },
        ],
      })
    );
    const result = await getChapterSourceAudio({
      fluentBibleId: 1,
      languageCode: 'eng',
      bookCode: 'JHN',
      chapter: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        ttsLicenseStatus: 'allowed',
        licenseNotice: 'BSB. Public domain.',
        bible: { fluentBibleId: 1, aquiferBibleId: 1 },
        items: [{ format: 'mp3' }],
      },
    });
  });

  it('carries the same Bible facts on DBL audio, including forbidden (recordings still play)', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({
        ...fluentBible,
        externalId: 'dbl-bsb',
        ttsLicenseStatus: 'forbidden',
        licenseNotice: 'Text licence notice',
      })
    );
    vi.mocked(bibleAudioService.getSourceAudio).mockResolvedValue(
      ok([
        {
          audioBibleId: 'recording',
          name: 'Recorded Bible',
          chapterId: 'JHN.3',
          resourceUrl: 'https://example.com/jhn3.mp3',
          expiresAt: null,
          timecodes: null,
        },
      ])
    );
    const result = await getChapterSourceAudio({
      fluentBibleId: 1,
      languageCode: 'eng',
      bookCode: 'JHN',
      chapter: 3,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        provider: 'dbl',
        ttsLicenseStatus: 'forbidden',
        licenseNotice: 'Text licence notice',
        items: [{ url: 'https://example.com/jhn3.mp3' }],
      },
    });
  });
});
