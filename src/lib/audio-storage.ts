import type { Buffer } from 'node:buffer';

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import env from '@/env';

import { logger } from './logger';

// Storage backend is Cloudflare R2 (S3-compatible API), per the project storage
// decision — data at rest must sit in a known EU jurisdiction (GDPR). The
// exported surface below keeps its original names so routes, services and tests
// did not have to change when Azure Blob was swapped out.
//
// This module stays audio-scoped and separate from lib/blob-storage.ts (USFM
// exports, PR #212): the two have different buckets and different lifecycles —
// exports are TTL-swept, recordings are permanent. Sharing one module is a
// follow-up once both have landed.

// How long a signed playback URL stays valid once issued.
const DOWNLOAD_TTL_SECONDS = 15 * 60;

// R2's S3 API is always signed against the "auto" region; the data region is
// pinned by the bucket's jurisdiction (encoded in the endpoint host), not here.
const R2_REGION = 'auto';

let s3Client: S3Client | null = null;

// Result of the boot-time bucket probe: null until it runs (and when storage is
// unconfigured, in which case it never runs), true/false once it has.
let bucketReachable: boolean | null = null;

export function isAudioStorageConfigured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

/**
 * Whether the verse-audio routes can serve. False when the R2 credentials are
 * unset, and also when the boot-time probe found the bucket unreachable — so a
 * bad bucket answers one clean 503 per request instead of a scattered 500 from
 * whichever S3 call happened to run. A failed probe still never stops the API
 * from booting: only this feature degrades (kaseywright, PR #212).
 */
export function isAudioStorageAvailable(): boolean {
  return isAudioStorageConfigured() && bucketReachable !== false;
}

/**
 * The bucket recordings live in — recorded on every storage_objects row.
 *
 * There is no default: env validation requires R2_AUDIO_BUCKET whenever the R2
 * credentials are set (see requireExplicitR2Buckets in src/env.ts), so a
 * validated environment always has one and never inherits a name another
 * environment owns. The throw below therefore only fires on the unconfigured
 * path, which isAudioStorageConfigured()/getS3Client() reject first.
 */
export function audioBucket(): string {
  const bucket = env.R2_AUDIO_BUCKET;
  if (!bucket) throw new Error('R2_AUDIO_BUCKET is not configured');
  return bucket;
}

/** Deterministic object key — replacement overwrites in place, never orphans. */
export function audioBlobName(projectUnitId: number, bibleTextId: number): string {
  return `unit-${projectUnitId}/text-${bibleTextId}`;
}

/**
 * Builds the R2 S3 endpoint, pinning the data-at-rest jurisdiction via the host:
 *   eu       → https://{account}.eu.r2.cloudflarestorage.com   (GDPR default)
 *   default  → https://{account}.r2.cloudflarestorage.com      (no pin)
 */
function buildR2Endpoint(accountId: string): string {
  // Explicit override wins — that is how local dev points at MinIO.
  if (env.R2_ENDPOINT) return env.R2_ENDPOINT;
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
    // The SDK's Node handler defaults to NO timeouts, so an unreachable bucket
    // would hang an upload, a delete or the reclaim sweep indefinitely.
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
  });
  return s3Client;
}

/**
 * Verifies the audio bucket is reachable. Optional at startup: when R2 is not
 * configured the verse-audio routes answer 503 and the rest of the API is
 * unaffected. The bucket is provisioned out-of-band (dashboard/IaC) so it can be
 * created in the correct GDPR jurisdiction — see .env.example.
 */
export async function initializeAudioStorage(): Promise<void> {
  const client = getS3Client();
  const bucket = audioBucket();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    bucketReachable = true;
  } catch (error) {
    // Recorded before rethrowing: the caller logs and keeps the API up, and the
    // routes read this to answer 503 rather than 500 (isAudioStorageAvailable).
    bucketReachable = false;
    throw new Error(
      `R2 audio bucket "${bucket}" is not reachable — it must be created ` +
        `in the "${env.R2_JURISDICTION}" jurisdiction (GDPR data-at-rest) before verse ` +
        `audio is enabled`,
      { cause: error }
    );
  }
  logger.info('R2 audio storage initialized', {
    bucket,
    jurisdiction: env.R2_JURISDICTION,
  });
}

export async function uploadVerseAudio(
  key: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  const bucket = audioBucket();
  // Recordings are capped at 30 MB by the route's bodyLimit and already buffered,
  // so a single PutObject is enough — no multipart upload needed.
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: data,
      ContentType: contentType,
      ContentLength: data.length,
    })
  );
  logger.info('Verse audio object uploaded', {
    bucket,
    key,
    sizeBytes: data.length,
    contentType,
  });
}

export async function deleteVerseAudio(key: string): Promise<void> {
  const bucket = audioBucket();
  // DeleteObject is idempotent on S3/R2: deleting a missing key succeeds, which
  // is what the reclaim sweep wants when a blob is already gone.
  await getS3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  logger.info('Verse audio object deleted', { bucket, key });
}

/** Short-lived read-only presigned URL that players stream directly from. */
export async function generateAudioDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(getS3Client(), new GetObjectCommand({ Bucket: audioBucket(), Key: key }), {
    expiresIn: DOWNLOAD_TTL_SECONDS,
  });
}
