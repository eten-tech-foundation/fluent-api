import { describe, expect, it, vi } from 'vitest';

import * as biblesRepo from '@/domains/bibles/bibles.repository';
import { getBookByCode } from '@/domains/books/books.service';
import { dblClient } from '@/lib/services/dbl/dbl.client';
import { dblAudioChapterSchema, dblBibleSchema } from '@/lib/services/dbl/dbl.types';
import { ok } from '@/lib/types';

import { getChapterSourceAudio } from './source-audio.service';

vi.mock('@/domains/bibles/bibles.repository', () => ({ getById: vi.fn() }));
vi.mock('@/domains/books/books.repository', () => ({
  getById: vi.fn().mockResolvedValue({ ok: true, data: { id: 43, code: 'JHN' } }),
}));
vi.mock('@/domains/books/books.service', () => ({ getBookByCode: vi.fn() }));
vi.mock('@/lib/services/dbl/dbl.client', () => ({
  dblClient: { getBible: vi.fn(), getAudioChapter: vi.fn() },
}));

describe('dBL expiry presence', () => {
  it.each([
    ['', undefined],
    [' ', undefined],
    ['\t', undefined],
    ['1788719940', 1788719940],
    [1788719940, 1788719940],
    [null, null],
    [undefined, undefined],
    [0, 0],
  ])('normalizes %s without changing populated timestamps', (input, expected) => {
    expect(
      dblAudioChapterSchema.parse({
        id: 'JHN.3',
        resourceUrl: 'https://example.com/audio.mp3',
        expiresAt: input,
      }).expiresAt
    ).toBe(expected);
  });

  it('an empty DBL expiresAt is published as absent, not as expired in 1970 — fluent-mobile dock reads this field', async () => {
    vi.mocked(biblesRepo.getById).mockResolvedValue(
      ok({
        id: 1,
        name: 'BSB',
        abbreviation: 'BSB',
        languageId: 1,
        provider: 'dbl',
        externalId: 'text-bible',
        aquiferBibleId: null,
        ttsLicenseStatus: 'unknown',
        licenseNotice: null,
        createdAt: null,
        updatedAt: null,
      })
    );
    vi.mocked(getBookByCode).mockResolvedValue(
      ok({ id: 43, code: 'JHN', eng_display_name: 'John' })
    );
    vi.mocked(dblClient.getBible).mockResolvedValue(
      ok(
        dblBibleSchema.parse({
          id: 'text-bible',
          name: 'BSB',
          nameLocal: 'BSB',
          abbreviation: 'BSB',
          abbreviationLocal: 'BSB',
          language: {
            id: 'eng',
            name: 'English',
            nameLocal: 'English',
            script: 'Latin',
            scriptDirection: 'LTR',
          },
          audioBibles: [{ id: 'audio-bible', name: 'BSB recording', nameLocal: 'BSB recording' }],
        })
      )
    );
    vi.mocked(dblClient.getAudioChapter).mockResolvedValue(
      ok(
        dblAudioChapterSchema.parse({
          id: 'JHN.3',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: '',
        })
      )
    );
    const result = await getChapterSourceAudio({
      fluentBibleId: 1,
      languageCode: 'eng',
      bookCode: 'JHN',
      chapter: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Source audio failed');
    expect(result.data.items).toHaveLength(1);
    expect(result.data.items[0]).not.toHaveProperty('expiresAt');
  });
});
