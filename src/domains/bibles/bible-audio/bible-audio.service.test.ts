import { describe, expect, it, vi } from 'vitest';

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

      // Mock 404 from DBL
      vi.mocked(dblClient.getAudioChapter).mockResolvedValue({
        ok: false,
        error: { code: ErrorCode.DBL_SERVICE_UNAVAILABLE, message: 'HTTP 404 Not Found' },
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
