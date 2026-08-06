import type { Readable } from 'node:stream';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Transform } from 'node:stream';

import env from '@/env';

import { logger } from './logger';

// Storage backend is Cloudflare R2 (S3-compatible API). The public surface below
// keeps its historical "Blob"/"BlobStorage" names so callers (routes, workers,
// tests) did not have to change when we swapped Azure Blob out for R2.

// Exported objects are considered expired after this long; expired objects 404
// on download and are removed by deleteExpiredExports (interval in the
// entrypoints).
export const EXPORT_TTL_MS = 3600000;

// How long a signed download URL stays valid once issued.
const SAS_TTL_MINUTES = 15;

// R2's S3 API is always signed against the "auto" region; the data region is
// pinned by the bucket's jurisdiction (encoded in the endpoint host), not here.
const R2_REGION = 'auto';

// Export objects are named `export-{jobId}.zip`, where jobId is a pg-boss UUID
// (see uploadExportStream). Both writing and cleanup key off this shape, so
// deleteExpiredExports can only ever delete objects this module wrote: a shared
// or misconfigured bucket can never lose unrelated objects to the TTL sweep.
// EXPORT_KEY_PATTERN encodes the same prefix and mirrors the download route's
// filename validation (usfm.route.ts). Bucket organization is a second layer of
// defence, not the only guard.
const EXPORT_KEY_PREFIX = 'export-';
const EXPORT_KEY_PATTERN = /^export-[a-f0-9-]+\.zip$/;

let s3Client: S3Client | null = null;

export function isBlobStorageConfigured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

/**
 * Builds the R2 S3 endpoint, pinning the data-at-rest jurisdiction via the host:
 *   eu       → https://{account}.eu.r2.cloudflarestorage.com   (GDPR default)
 *   default  → https://{account}.r2.cloudflarestorage.com      (no pin)
 */
function buildR2Endpoint(accountId: string): string {
  const jurisdiction = env.R2_JURISDICTION.trim().toLowerCase();
  const segment = jurisdiction && jurisdiction !== 'default' ? `${jurisdiction}.` : '';
  return `https://${accountId}.${segment}r2.cloudflarestorage.com`;
}

function getS3Client(): S3Client {
  if (s3Client) return s3Client;

  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Cloudflare R2 credentials are not configured');
  }

  s3Client = new S3Client({
    region: R2_REGION,
    endpoint: buildR2Endpoint(accountId),
    // R2 is addressed path-style ({account}.../{bucket}/{key}); virtual-hosted
    // style would fold the bucket into the host and break the jurisdiction host.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  return s3Client;
}

function isNotFound(error: unknown): boolean {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err?.name === 'NotFound' || err?.$metadata?.httpStatusCode === 404;
}

/**
 * Verifies the exports bucket is reachable. Call once at process startup so a
 * missing/misconfigured bucket fails fast here rather than on the first upload.
 * The bucket itself is provisioned out-of-band (dashboard/IaC) so it can be
 * created in the correct GDPR jurisdiction — see .env.example.
 */
export async function initializeBlobStorage(): Promise<void> {
  const client = getS3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.R2_EXPORTS_BUCKET }));
  } catch (error) {
    throw new Error(
      `R2 exports bucket "${env.R2_EXPORTS_BUCKET}" is not reachable — it must be ` +
        `created in the "${env.R2_JURISDICTION}" jurisdiction (GDPR data-at-rest) ` +
        `before async export is enabled`,
      { cause: error }
    );
  }
  logger.info('R2 export storage initialized', {
    bucket: env.R2_EXPORTS_BUCKET,
    jurisdiction: env.R2_JURISDICTION,
  });
}

/**
 * Boot-time storage check for the API entrypoint. Never throws: async export is
 * not exposed to the UI yet, so a bucket typo, rotated key, or transient R2
 * outage must degrade only this feature — never block the whole API from
 * booting. Unconfigured credentials keep the async endpoints on their 503 path;
 * an unreachable bucket surfaces per-job in the worker. The dedicated export
 * worker (standalone-worker.ts) still fails fast on the throwing
 * initializeBlobStorage, since storage is load-bearing there.
 */
export async function verifyBlobStorageOnBoot(): Promise<boolean> {
  if (!isBlobStorageConfigured()) {
    logger.warn('R2 export storage not configured — async USFM export endpoints will respond 503');
    return false;
  }
  try {
    await initializeBlobStorage();
    return true;
  } catch (error) {
    logger.warn(
      'R2 export storage is unreachable — API will start, but async USFM export jobs will fail until storage is fixed',
      { error }
    );
    return false;
  }
}

// The explicit index signature keeps this assignable to the SDK's Metadata type
// (Record<string, string>). Object metadata keys are lowercased by S3/R2, so
// these are declared lowercase to match what reads back.
export interface ExportBlobMetadata {
  [key: string]: string;
  /** User id of the requester, as a string (object metadata values are strings). */
  requestedby: string;
  projectunitid: string;
}

/**
 * Streams an export ZIP into object storage without buffering it in memory.
 * Returns the stored object name and its size.
 */
export async function uploadExportStream(
  jobId: string,
  stream: Readable,
  metadata: ExportBlobMetadata
): Promise<{ filename: string; sizeBytes: number; expiresAt: Date }> {
  const filename = `${EXPORT_KEY_PREFIX}${jobId}.zip`;

  let sizeBytes = 0;
  const byteCounter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });

  // lib-storage's Upload multipart-uploads a stream of unknown length without
  // buffering the whole archive in memory.
  const upload = new Upload({
    client: getS3Client(),
    params: {
      Bucket: env.R2_EXPORTS_BUCKET,
      Key: filename,
      Body: stream.pipe(byteCounter),
      ContentType: 'application/zip',
      Metadata: metadata,
    },
  });
  await upload.done();

  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
  logger.info('Export object uploaded', { filename, sizeBytes, expiresAt });
  return { filename, sizeBytes, expiresAt };
}

export interface ExportBlobInfo {
  metadata: Partial<ExportBlobMetadata>;
  createdOn: Date;
  contentLength?: number;
}

/** Returns object metadata, or null when the object does not exist or has expired. */
export async function getExportBlobInfo(filename: string): Promise<ExportBlobInfo | null> {
  try {
    const head = await getS3Client().send(
      new HeadObjectCommand({ Bucket: env.R2_EXPORTS_BUCKET, Key: filename })
    );
    const createdOn = head.LastModified;
    // No creation timestamp (anomalous) or past the export TTL -> treat as gone,
    // so the download route 404s instead of signing a stale object.
    if (!createdOn || Date.now() - createdOn.getTime() > EXPORT_TTL_MS) {
      return null;
    }
    return {
      metadata: (head.Metadata ?? {}) as Partial<ExportBlobMetadata>,
      createdOn,
      contentLength: head.ContentLength,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * Generates a short-lived read-only presigned URL for a stored export. The URL
 * lifetime is capped at the export's own remaining TTL so it can never outlive
 * the object: getExportBlobInfo starts returning null (404) once an export is
 * older than EXPORT_TTL_MS, and without this cap a URL signed moments before that
 * boundary would keep working for up to SAS_TTL_MINUTES afterwards. Pass the
 * createdOn from getExportBlobInfo; an already-elapsed timestamp is rejected.
 */
export async function generateExportDownloadUrl(
  filename: string,
  createdOn: Date
): Promise<string> {
  const remainingSeconds = Math.floor((EXPORT_TTL_MS - (Date.now() - createdOn.getTime())) / 1000);
  if (remainingSeconds <= 0) {
    throw new Error(`Export "${filename}" has expired and cannot be signed for download`);
  }
  const expiresIn = Math.min(SAS_TTL_MINUTES * 60, remainingSeconds);
  const command = new GetObjectCommand({ Bucket: env.R2_EXPORTS_BUCKET, Key: filename });
  return getSignedUrl(getS3Client(), command, { expiresIn });
}

// Note: R2 supports object lifecycle rules (server-side TTL) that can replace
// this application-level sweep once configured on the bucket; it stays for local
// (MinIO) parity and pre-enablement volumes.
/** Deletes export objects older than EXPORT_TTL_MS. Safe to call on an interval. */
export async function deleteExpiredExports(): Promise<void> {
  try {
    const client = getS3Client();
    let deletedCount = 0;
    let continuationToken: string | undefined;

    do {
      const list = await client.send(
        new ListObjectsV2Command({
          Bucket: env.R2_EXPORTS_BUCKET,
          // Scope the listing to our own key prefix. This narrows what the sweep
          // can touch (and cuts listing cost on a large bucket) so unrelated
          // objects are never even considered for deletion.
          Prefix: EXPORT_KEY_PREFIX,
          ContinuationToken: continuationToken,
        })
      );

      for (const object of list.Contents ?? []) {
        if (!object.Key) continue;
        // Defence in depth on top of the Prefix above: only ever delete keys that
        // match the full export naming shape, so an object that merely shares the
        // prefix (or a shared/misconfigured bucket) can never be swept by TTL.
        if (!EXPORT_KEY_PATTERN.test(object.Key)) continue;
        const lastModified = object.LastModified;
        if (lastModified && Date.now() - lastModified.getTime() > EXPORT_TTL_MS) {
          try {
            await client.send(
              new DeleteObjectCommand({ Bucket: env.R2_EXPORTS_BUCKET, Key: object.Key })
            );
            deletedCount++;
          } catch (error) {
            // A concurrent sweep (e.g. an overlapping worker restart) may have
            // already removed this object; a 404 is benign. Re-throw anything
            // else so the outer catch logs it.
            if (!isNotFound(error)) throw error;
          }
        }
      }

      continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
    } while (continuationToken);

    if (deletedCount > 0) {
      logger.info('Cleaned up expired export objects', { deletedCount });
    }
  } catch (error) {
    logger.error('Failed to clean up expired export objects', { error });
  }
}
