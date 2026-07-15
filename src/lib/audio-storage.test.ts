import { describe, expect, it } from 'vitest';

import {
  audioBlobName,
  generateAudioDownloadUrl,
  isAudioStorageConfigured,
} from '@/lib/audio-storage';

// .env.test does not define AZURE_STORAGE_CONNECTION_STRING, so these tests
// exercise the unconfigured path (the configured path is covered by the
// service tests with this module mocked).
describe('audio-storage', () => {
  it('derives a deterministic blob name per unit + verse', () => {
    expect(audioBlobName(12, 3401)).toBe('unit-12/text-3401');
  });

  it('reports unconfigured when the connection string is unset', () => {
    expect(isAudioStorageConfigured()).toBe(false);
  });

  it('throws on SAS generation when storage is unconfigured', () => {
    expect(() => generateAudioDownloadUrl('unit-1/text-2')).toThrow(
      'AZURE_STORAGE_CONNECTION_STRING'
    );
  });
});
