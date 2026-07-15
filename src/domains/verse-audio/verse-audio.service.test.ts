import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audioBlobName,
  deleteVerseAudio,
  generateAudioDownloadUrl,
  uploadVerseAudio,
} from '@/lib/audio-storage';
import { err, ErrorCode, ok } from '@/lib/types';

import type { VerseAudioRecord } from './verse-audio.types';

import * as repo from './verse-audio.repository';
import {
  deleteRecording,
  getRecording,
  listChapterRecordings,
  uploadRecording,
} from './verse-audio.service';

vi.mock('@/lib/audio-storage', () => ({
  audioBlobName: vi.fn((unitId: number, textId: number) => `unit-${unitId}/text-${textId}`),
  uploadVerseAudio: vi.fn(async () => {}),
  deleteVerseAudio: vi.fn(async () => {}),
  generateAudioDownloadUrl: vi.fn(() => 'https://blob.example/unit-12/text-3401?sas'),
}));

vi.mock('./verse-audio.repository', () => ({
  get: vi.fn(),
  listByChapter: vi.fn(),
  upsert: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const record: VerseAudioRecord = {
  id: 1,
  projectUnitId: 12,
  bibleTextId: 3401,
  uploadedBy: 7,
  contentType: 'audio/mp4',
  sizeBytes: 4,
  durationSeconds: 12.5,
  verseNumber: 3,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const uploadInput = {
  projectUnitId: 12,
  bibleTextId: 3401,
  uploadedBy: 7,
  contentType: 'audio/mp4',
  data: Buffer.from('abcd'),
  durationSeconds: 12.5,
};

describe('verse-audio service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadVerseAudio).mockResolvedValue(undefined);
    vi.mocked(deleteVerseAudio).mockResolvedValue(undefined);
  });

  describe('uploadRecording', () => {
    it('uploads the blob then upserts metadata and returns a download URL', async () => {
      vi.mocked(repo.upsert).mockResolvedValue(ok(record));

      const result = await uploadRecording(uploadInput);

      expect(uploadVerseAudio).toHaveBeenCalledWith(
        'unit-12/text-3401',
        uploadInput.data,
        'audio/mp4'
      );
      expect(repo.upsert).toHaveBeenCalledWith({
        projectUnitId: 12,
        bibleTextId: 3401,
        uploadedBy: 7,
        contentType: 'audio/mp4',
        sizeBytes: 4,
        durationSeconds: 12.5,
      });
      expect(result).toEqual(
        ok({ ...record, downloadUrl: 'https://blob.example/unit-12/text-3401?sas' })
      );
    });

    it('rejects unsupported content types without touching storage', async () => {
      const result = await uploadRecording({ ...uploadInput, contentType: 'video/mp4' });

      expect(result).toEqual(err(ErrorCode.UNSUPPORTED_AUDIO_TYPE));
      expect(uploadVerseAudio).not.toHaveBeenCalled();
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('rejects empty files without touching storage', async () => {
      const result = await uploadRecording({ ...uploadInput, data: Buffer.alloc(0) });

      expect(result).toEqual(err(ErrorCode.EMPTY_AUDIO_FILE));
      expect(uploadVerseAudio).not.toHaveBeenCalled();
    });

    it('returns INTERNAL_ERROR and skips the DB when the blob upload throws', async () => {
      vi.mocked(uploadVerseAudio).mockRejectedValue(new Error('azure down'));

      const result = await uploadRecording(uploadInput);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('propagates repository upsert failures', async () => {
      vi.mocked(repo.upsert).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

      const result = await uploadRecording(uploadInput);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
    });

    it('defaults durationSeconds to null when not provided', async () => {
      vi.mocked(repo.upsert).mockResolvedValue(ok(record));

      await uploadRecording({ ...uploadInput, durationSeconds: undefined });

      expect(repo.upsert).toHaveBeenCalledWith(expect.objectContaining({ durationSeconds: null }));
    });
  });

  describe('getRecording', () => {
    it('attaches a download URL to the stored record', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));

      const result = await getRecording(12, 3401);

      expect(repo.get).toHaveBeenCalledWith(12, 3401);
      expect(audioBlobName).toHaveBeenCalledWith(12, 3401);
      expect(result).toEqual(
        ok({ ...record, downloadUrl: 'https://blob.example/unit-12/text-3401?sas' })
      );
    });

    it('propagates not-found from the repository', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

      const result = await getRecording(12, 3401);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      expect(generateAudioDownloadUrl).not.toHaveBeenCalled();
    });
  });

  describe('listChapterRecordings', () => {
    it('attaches a download URL to every row', async () => {
      const second = { ...record, id: 2, bibleTextId: 3402, verseNumber: 4 };
      vi.mocked(repo.listByChapter).mockResolvedValue(ok([record, second]));

      const result = await listChapterRecordings(12, 1, 3);

      expect(repo.listByChapter).toHaveBeenCalledWith(12, 1, 3);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toHaveLength(2);
        expect(result.data.every((r) => r.downloadUrl.length > 0)).toBe(true);
      }
    });
  });

  describe('deleteRecording', () => {
    it('deletes the blob then the row', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(repo.remove).mockResolvedValue(ok(undefined));

      const result = await deleteRecording(12, 3401);

      expect(deleteVerseAudio).toHaveBeenCalledWith('unit-12/text-3401');
      expect(repo.remove).toHaveBeenCalledWith(12, 3401);
      expect(result).toEqual(ok(undefined));
    });

    it('returns not-found without touching the blob when no recording exists', async () => {
      vi.mocked(repo.get).mockResolvedValue(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));

      const result = await deleteRecording(12, 3401);

      expect(result).toEqual(err(ErrorCode.VERSE_AUDIO_NOT_FOUND));
      expect(deleteVerseAudio).not.toHaveBeenCalled();
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('returns INTERNAL_ERROR and keeps the row when blob deletion throws', async () => {
      vi.mocked(repo.get).mockResolvedValue(ok(record));
      vi.mocked(deleteVerseAudio).mockRejectedValue(new Error('azure down'));

      const result = await deleteRecording(12, 3401);

      expect(result).toEqual(err(ErrorCode.INTERNAL_ERROR));
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });
});
