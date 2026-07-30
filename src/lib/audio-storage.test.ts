import { describe, expect, it } from 'vitest';

import {
  audioBlobName,
  audioBucket,
  generateAudioDownloadUrl,
  isAudioStorageConfigured,
} from '@/lib/audio-storage';

// .env.test defines no R2 credentials, so these exercise the unconfigured path
// (the configured path is covered by the service tests with this module mocked).
describe('audio-storage', () => {
  it('derives a deterministic object key per unit + verse', () => {
    expect(audioBlobName(12, 3401)).toBe('unit-12/text-3401');
  });

  it('reports unconfigured when the R2 credentials are unset', () => {
    expect(isAudioStorageConfigured()).toBe(false);
  });

  it('exposes the configured audio bucket, separate from the exports bucket', () => {
    expect(audioBucket()).toBe('verse-audio');
  });

  it('rejects presigning when storage is unconfigured', async () => {
    await expect(generateAudioDownloadUrl('unit-1/text-2')).rejects.toThrow(
      'Cloudflare R2 credentials are not configured'
    );
  });
});
