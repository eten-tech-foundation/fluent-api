import type { ContainerClient } from '@azure/storage-blob';
import type { Buffer } from 'node:buffer';

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';

import env from '@/env';

import { logger } from './logger';

// NOTE: main has no Azure blob code — the async-export blob module exists only
// on the unmerged feat/196-async-export-hardening branch. This module is
// deliberately audio-scoped and separately named so the two branches merge
// cleanly; exports can migrate onto a shared module later.

// How long a signed playback URL stays valid once issued.
const SAS_TTL_MINUTES = 15;

let containerClient: ContainerClient | null = null;
let sharedKeyCredential: StorageSharedKeyCredential | null = null;
let containerEnsured = false;

export function isAudioStorageConfigured(): boolean {
  return Boolean(env.AZURE_STORAGE_CONNECTION_STRING);
}

/** Deterministic blob name — replacement overwrites in place, never orphans. */
export function audioBlobName(projectUnitId: number, bibleTextId: number): string {
  return `unit-${projectUnitId}/text-${bibleTextId}`;
}

function getContainerClient(): ContainerClient {
  if (containerClient) return containerClient;

  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }

  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);

  // Only a shared-key credential (connection string with AccountKey) can sign
  // SAS URLs — fail fast on anything else rather than at the first download.
  if (!(serviceClient.credential instanceof StorageSharedKeyCredential)) {
    throw new TypeError(
      'AZURE_STORAGE_CONNECTION_STRING must include an AccountKey to sign SAS URLs'
    );
  }

  sharedKeyCredential = serviceClient.credential;
  containerClient = serviceClient.getContainerClient(env.AUDIO_CONTAINER);
  return containerClient;
}

// Lazily ensures the container exists on first write/delete — avoids touching
// the server/worker entrypoints for an optional feature.
async function ensureContainer(): Promise<ContainerClient> {
  const client = getContainerClient();
  if (!containerEnsured) {
    await client.createIfNotExists();
    containerEnsured = true;
    logger.info('Audio storage container ready', { container: env.AUDIO_CONTAINER });
  }
  return client;
}

export async function uploadVerseAudio(
  blobName: string,
  data: Buffer,
  contentType: string
): Promise<void> {
  const client = await ensureContainer();
  await client.getBlockBlobClient(blobName).uploadData(data, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  logger.info('Verse audio blob uploaded', { blobName, sizeBytes: data.length, contentType });
}

export async function deleteVerseAudio(blobName: string): Promise<void> {
  const client = await ensureContainer();
  await client.getBlockBlobClient(blobName).deleteIfExists();
  logger.info('Verse audio blob deleted', { blobName });
}

/** Short-lived read-only SAS URL mobile/web players stream directly from. */
export function generateAudioDownloadUrl(blobName: string): string {
  const client = getContainerClient();
  if (!sharedKeyCredential) {
    throw new Error('Audio storage credential not initialized');
  }

  const startsOn = new Date(Date.now() - 60 * 1000); // clock-skew allowance
  const expiresOn = new Date(Date.now() + SAS_TTL_MINUTES * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: client.containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    sharedKeyCredential
  ).toString();

  return `${client.getBlobClient(blobName).url}?${sas}`;
}
