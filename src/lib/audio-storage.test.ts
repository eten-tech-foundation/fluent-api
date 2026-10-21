import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  audioBlobName,
  audioBucket,
  generateAudioDownloadUrl,
  initializeAudioStorage,
  isAudioStorageAvailable,
  isAudioStorageConfigured,
} from '@/lib/audio-storage';

// mockEnv is a live object so each block can set or blank the R2 block, mirroring
// blob-storage.test.ts. It starts UNCONFIGURED, which is also what .env.test is.
const { sendMock, mockEnv } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  mockEnv: {
    R2_ACCOUNT_ID: '',
    R2_ACCESS_KEY_ID: '',
    R2_SECRET_ACCESS_KEY: '',
    R2_JURISDICTION: 'eu',
    R2_ENDPOINT: undefined as string | undefined,
    R2_AUDIO_BUCKET: '',
  },
}));

vi.mock('@/env', () => ({ default: mockEnv }));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = sendMock;
    },
    HeadBucketCommand: class extends S3Command {},
    PutObjectCommand: class extends S3Command {},
    DeleteObjectCommand: class extends S3Command {},
    GetObjectCommand: class extends S3Command {},
  };
});

// Runs first on purpose: the S3 client is memoized once built, so the
// unconfigured-credentials path has to be exercised before anything configures it.
describe('audio-storage without R2 configured', () => {
  it('derives a deterministic object key per unit + verse + content hash', () => {
    expect(audioBlobName(12, 3401, 'abc123')).toBe('unit-12/text-3401/abc123');
  });

  it('reports unconfigured, and unavailable, when the R2 credentials are unset', () => {
    expect(isAudioStorageConfigured()).toBe(false);
    expect(isAudioStorageAvailable()).toBe(false);
  });

  it('refuses to name a bucket rather than falling back to a shared default', () => {
    // No default exists any more: env validation requires R2_AUDIO_BUCKET
    // alongside the credentials, so this only ever fires when R2 is off.
    expect(() => audioBucket()).toThrow('R2_AUDIO_BUCKET is not configured');
  });

  it('rejects presigning when storage is unconfigured', async () => {
    await expect(generateAudioDownloadUrl('unit-1/text-2')).rejects.toThrow(
      'Cloudflare R2 credentials are not configured'
    );
  });
});

describe('initializeAudioStorage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.R2_ACCOUNT_ID = 'test-account';
    mockEnv.R2_ACCESS_KEY_ID = 'test-key';
    mockEnv.R2_SECRET_ACCESS_KEY = 'test-secret';
    mockEnv.R2_AUDIO_BUCKET = 'fluent-audio-recordings-dev';
  });

  it('probes the configured bucket and leaves storage available', async () => {
    sendMock.mockResolvedValue({});

    await initializeAudioStorage();

    const headCommand = sendMock.mock.calls
      .map((call) => call[0])
      .find((command) => command instanceof HeadBucketCommand);
    expect(headCommand?.input.Bucket).toBe('fluent-audio-recordings-dev');
    expect(isAudioStorageAvailable()).toBe(true);
  });

  it('marks storage unavailable when the bucket cannot be reached', async () => {
    // The API still boots (the caller in index.ts logs and moves on, per the
    // PR #212 review); the routes just answer 503 instead of a 500 per request.
    sendMock.mockRejectedValue(new Error('NoSuchBucket'));

    await expect(initializeAudioStorage()).rejects.toThrow('is not reachable');

    expect(isAudioStorageConfigured()).toBe(true);
    expect(isAudioStorageAvailable()).toBe(false);
  });
});
