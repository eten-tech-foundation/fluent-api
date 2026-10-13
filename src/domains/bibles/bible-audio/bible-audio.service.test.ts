import { describe, expect, it, vi } from 'vitest';

import type { Bible } from '@/domains/bibles/bibles.types';
import type { Book } from '@/domains/books/books.types';
import type { DblBible } from '@/lib/services/dbl/dbl.types';

import { dblClient } from '@/lib/services/dbl/dbl.client';
import { ErrorCode, ok } from '@/lib/types';

import * as booksRepo from '../../books/books.repository';
import * as biblesRepo from '../bibles.repository';
import * as bibleAudioService from './bible-audio.service';

vi.mock('@/lib/services/dbl/dbl.client', () => ({
  dblClient: {
    getBible: vi.fn(),
    getAudioChapter: vi.fn(),
  },
}));

vi.mock('../../books/books.repository', () => ({
  getById: vi.fn(),
}));

vi.mock('../bibles.repository', () => ({
  getById: vi.fn(),
}));

const BIBLE: Bible = {
  id: 1,
  languageId: 1,
  name: 'Test Bible',
  abbreviation: 'TEST',
  provider: 'dbl',
  externalId: 'ext-bible',
  hasAudio: false,
  audioResourceId: null,
  createdAt: null,
  updatedAt: null,
};

const BOOK: Book = { id: 1, code: 'GEN', eng_display_name: 'Genesis' };

const DBL_BIBLE = {
  id: 'ext-bible',
  abbreviation: 'TEST',
  abbreviationLocal: 'TEST',
  language: {
    id: 'eng',
    name: 'English',
    nameLocal: 'English',
    script: 'Latin',
    scriptDirection: 'LTR',
  },
  countries: [],
  name: 'Test Bible',
  nameLocal: 'Test Bible',
  description: null,
  descriptionLocal: null,
  relatedDbl: null,
  type: 'text',
  updatedAt: null,
  audioBibles: [{ id: 'audio-1', name: 'Audio Bible', nameLocal: 'Audio Bible' }],
  copyright: null,
  info: null,
} satisfies DblBible;

describe('bibleAudioService', () => {
  describe('getSourceAudio', () => {
    it('returns empty array if bible has no externalId', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ externalId: null } as any));

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it('returns empty array if DBL Bible has no audioBibles', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ externalId: 'ext-bible' } as any));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok({ code: 'GEN' } as any));
      vi.mocked(dblClient.getBible).mockResolvedValue(ok({ audioBibles: [] } as any));

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it('returns empty array and ignores 404s for missing audio chapters', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ externalId: 'ext-bible' } as any));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok({ code: 'GEN' } as any));
      vi.mocked(dblClient.getBible).mockResolvedValue(
        ok({
          audioBibles: [{ id: 'audio-1', name: 'Audio Bible' }],
        } as any)
      );

      vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
        ok: false,
        error: {
          code: ErrorCode.DBL_AUDIO_CHAPTER_NOT_FOUND,
          message: 'DBL audio chapter not found',
        },
      } as any);

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual([]);
      }
    });

    it('returns DBL_SERVICE_UNAVAILABLE if DBL fails with a 500/timeout', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ externalId: 'ext-bible' } as any));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok({ code: 'GEN' } as any));
      vi.mocked(dblClient.getBible).mockResolvedValue(
        ok({
          audioBibles: [{ id: 'audio-1', name: 'Audio Bible' }],
        } as any)
      );

      // Mock 503 from DBL (real outage)
      vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.DBL_SERVICE_UNAVAILABLE, message: 'HTTP 503 Service Unavailable' },
      } as any);

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.DBL_SERVICE_UNAVAILABLE);
      }
    });

    it('does not mistake an upstream failure message mentioning 404 for chapter absence', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok(BIBLE));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok(BOOK));
      vi.mocked(dblClient.getBible).mockResolvedValue(ok(DBL_BIBLE));
      vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
        ok: false,
        error: {
          code: ErrorCode.DBL_SERVICE_UNAVAILABLE,
          message: 'proxy returned malformed 404-shaped payload',
        },
      });

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);

      expect(result).toEqual({
        ok: false,
        error: {
          code: ErrorCode.DBL_SERVICE_UNAVAILABLE,
          message: 'proxy returned malformed 404-shaped payload',
        },
      });
    });

    it('propagates missing DBL configuration without treating it as absent audio', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok(BIBLE));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok(BOOK));
      vi.mocked(dblClient.getBible).mockResolvedValue(ok(DBL_BIBLE));
      vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
        ok: false,
        error: {
          code: ErrorCode.DBL_NOT_CONFIGURED,
          message: 'DBL API key is not configured',
        },
      });

      expect(await bibleAudioService.getSourceAudio(1, 1, 1)).toMatchObject({
        ok: false,
        error: { code: ErrorCode.DBL_NOT_CONFIGURED },
      });
    });

    it('returns audio tracks on success', async () => {
      vi.mocked(biblesRepo.getById).mockResolvedValue(ok({ externalId: 'ext-bible' } as any));
      vi.mocked(booksRepo.getById).mockResolvedValue(ok({ code: 'GEN' } as any));
      vi.mocked(dblClient.getBible).mockResolvedValue(
        ok({
          name: 'Test Bible',
          audioBibles: [{ id: 'audio-1', name: 'Audio Bible' }],
        } as any)
      );

      vi.mocked(dblClient.getAudioChapter).mockResolvedValue(
        ok({
          id: 'GEN.1',
          resourceUrl: 'https://example.com/audio.mp3',
          expiresAt: 1234567890,
          timecodes: [],
        } as any)
      );

      const result = await bibleAudioService.getSourceAudio(1, 1, 1);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].resourceUrl).toBe('https://example.com/audio.mp3');
      }
    });
  });
});
