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

export function isAudioStorageConfigured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY);
}

/** The bucket recordings live in — recorded on every storage_objects row. */
export function audioBucket(): string {
  return env.R2_AUDIO_BUCKET;
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

/**
 * Verifies the audio bucket is reachable. Optional at startup: when R2 is not
 * configured the verse-audio routes answer 503 and the rest of the API is
 * unaffected. The bucket is provisioned out-of-band (dashboard/IaC) so it can be
 * created in the correct GDPR jurisdiction — see .env.example.
 */
export async function initializeAudioStorage(): Promise<void> {
  const client = getS3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.R2_AUDIO_BUCKET }));
  } catch (error) {
    throw new Error(
      `R2 audio bucket "${env.R2_AUDIO_BUCKET}" is not reachable — it must be created ` +
        `in the "${env.R2_JURISDICTION}" jurisdiction (GDPR data-at-rest) before verse ` +
        `audio is enabled`,
      { cause: error }
    );
  }
  logger.info('R2 audio storage initialized', {
    bucket: env.R2_AUDIO_BUCKET,
    jurisdiction: env.R2_JURISDICTION,
  });
}

export async function uploadVerseAudio(
  key: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  // Recordings are capped at 30 MB by the route's bodyLimit and already buffered,
  // so a single PutObject is enough — no multipart upload needed.
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: env.R2_AUDIO_BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
      ContentLength: data.length,
    })
  );
  logger.info('Verse audio object uploaded', {
    bucket: env.R2_AUDIO_BUCKET,
    key,
    sizeBytes: data.length,
    contentType,
  });
}

export async function deleteVerseAudio(key: string): Promise<void> {
  // DeleteObject is idempotent on S3/R2: deleting a missing key succeeds, which
  // is what the reclaim sweep wants when a blob is already gone.
  await getS3Client().send(new DeleteObjectCommand({ Bucket: env.R2_AUDIO_BUCKET, Key: key }));
  logger.info('Verse audio object deleted', { bucket: env.R2_AUDIO_BUCKET, key });
}

/** Short-lived read-only presigned URL that players stream directly from. */
export async function generateAudioDownloadUrl(key: string): Promise<string> {
  return getSignedUrl(
    getS3Client(),
    new GetObjectCommand({ Bucket: env.R2_AUDIO_BUCKET, Key: key }),
    { expiresIn: DOWNLOAD_TTL_SECONDS }
  );
}
