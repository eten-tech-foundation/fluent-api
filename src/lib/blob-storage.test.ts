import { DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteExpiredExports, generateExportDownloadUrl, getExportBlobInfo } from './blob-storage';

// Shared, hoisted so the mocked S3Client.send and the test body reference the
// same spy.
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));

vi.mock('@/env', () => ({
  default: {
    R2_ACCOUNT_ID: 'test-account',
    R2_ACCESS_KEY_ID: 'test-key',
    R2_SECRET_ACCESS_KEY: 'test-secret',
    R2_JURISDICTION: 'eu',
    R2_EXPORTS_BUCKET: 'usfm-exports',
  },
}));

vi.mock('./logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Presigner and lib-storage are imported at module load but not exercised here;
// stub them so their internals never touch the partial client-s3 mock below.
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: vi.fn() }));

vi.mock('@aws-sdk/client-s3', () => {
  class S3Command {
    constructor(public readonly input: Record<string, unknown>) {}
  }
  return {
    S3Client: class {
      send = sendMock;
    },
    ListObjectsV2Command: class extends S3Command {},
    DeleteObjectCommand: class extends S3Command {},
    HeadBucketCommand: class extends S3Command {},
    HeadObjectCommand: class extends S3Command {},
    GetObjectCommand: class extends S3Command {},
  };
});

const HOUR_MS = 60 * 60 * 1000;

describe('deleteExpiredExports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sweeps only expired objects whose key matches the export pattern', async () => {
    // Older than EXPORT_TTL_MS (1h), so age alone would make every object below
    // eligible for the old, unscoped sweep.
    const expired = new Date(Date.now() - 2 * HOUR_MS);
    sendMock.mockImplementation(async (command: unknown) => {
      if (command instanceof ListObjectsV2Command) {
        return {
          Contents: [
            // A real export object — this is the only key that should be deleted.
            { Key: 'export-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.zip', LastModified: expired },
            // Unrelated objects that merely happen to be old — must survive even
            // if the bucket is shared/misconfigured.
            { Key: 'audio-recording-987.webm', LastModified: expired },
            { Key: 'project-backup.tar.gz', LastModified: expired },
            // Shares the export- prefix but is not an export ZIP: the regex (not
            // just the list Prefix) has to skip it.
            { Key: 'export-notes.txt', LastModified: expired },
          ],
          IsTruncated: false,
        };
      }
      return {};
    });

    await deleteExpiredExports();

    const deletedKeys = sendMock.mock.calls
      .map((call) => call[0])
      .filter((command) => command instanceof DeleteObjectCommand)
      .map((command) => command.input.Key);

    expect(deletedKeys).toEqual(['export-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.zip']);
  });

  it('scopes the bucket listing to the export key prefix', async () => {
    sendMock.mockResolvedValue({ Contents: [], IsTruncated: false });

    await deleteExpiredExports();

    const listCommand = sendMock.mock.calls
      .map((call) => call[0])
      .find((command) => command instanceof ListObjectsV2Command);

    expect(listCommand?.input.Prefix).toBe('export-');
  });
});

describe('getExportBlobInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when the object has no creation timestamp', async () => {
    sendMock.mockResolvedValue({ Metadata: { requestedby: '1' } });

    expect(await getExportBlobInfo('export-x.zip')).toBeNull();
  });

  it('returns null when the object is older than the export TTL', async () => {
    sendMock.mockResolvedValue({
      LastModified: new Date(Date.now() - 2 * HOUR_MS),
      Metadata: { requestedby: '1' },
    });

    expect(await getExportBlobInfo('export-x.zip')).toBeNull();
  });

  it('returns metadata and timestamp for a live object', async () => {
    const createdOn = new Date(Date.now() - 60 * 1000);
    sendMock.mockResolvedValue({
      LastModified: createdOn,
      Metadata: { requestedby: '7' },
      ContentLength: 42,
    });

    const info = await getExportBlobInfo('export-x.zip');

    expect(info?.createdOn).toEqual(createdOn);
    expect(info?.metadata.requestedby).toBe('7');
    expect(info?.contentLength).toBe(42);
  });
});

describe('generateExportDownloadUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs for the full 15-minute window when ample TTL remains', async () => {
    await generateExportDownloadUrl('export-x.zip', new Date(Date.now() - 5 * 60 * 1000));

    const options = vi.mocked(getSignedUrl).mock.calls[0]?.[2];
    expect(options?.expiresIn).toBe(15 * 60);
  });

  it('caps the URL lifetime at the export remaining TTL near expiry', async () => {
    // ~1 minute of TTL left: the signed URL must not outlive the object.
    await generateExportDownloadUrl('export-x.zip', new Date(Date.now() - (HOUR_MS - 60 * 1000)));

    const options = vi.mocked(getSignedUrl).mock.calls[0]?.[2];
    expect(options?.expiresIn).toBeGreaterThan(0);
    expect(options?.expiresIn).toBeLessThan(15 * 60);
  });

  it('rejects an already-expired export instead of signing a URL', async () => {
    await expect(
      generateExportDownloadUrl('export-x.zip', new Date(Date.now() - 2 * HOUR_MS))
    ).rejects.toThrow(/expired/);

    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});
