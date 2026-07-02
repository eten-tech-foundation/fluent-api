import type { ContainerClient } from '@azure/storage-blob';
import type { Readable } from 'node:stream';

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { Transform } from 'node:stream';

import env from '@/env';

import { logger } from './logger';

// Exported blobs are considered expired after this long; expired blobs 404 on
// download and are removed by deleteExpiredExports (interval in the entrypoints).
export const EXPORT_TTL_MS = 3600000;

// How long a signed download URL stays valid once issued.
const SAS_TTL_MINUTES = 15;

let containerClient: ContainerClient | null = null;
let sharedKeyCredential: StorageSharedKeyCredential | null = null;

export function isBlobStorageConfigured(): boolean {
  return Boolean(env.AZURE_STORAGE_CONNECTION_STRING);
}

function getContainerClient(): ContainerClient {
  if (containerClient) return containerClient;

  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }

  const serviceClient = BlobServiceClient.fromConnectionString(connectionString);

  // A connection string with an AccountKey yields a shared-key credential,
  // which is what signs download SAS URLs. Anything else (SAS-only string,
  // managed identity) cannot sign, so fail fast at startup rather than at
  // the first download.
  if (!(serviceClient.credential instanceof StorageSharedKeyCredential)) {
    throw new TypeError(
      'AZURE_STORAGE_CONNECTION_STRING must include an AccountKey to sign SAS URLs'
    );
  }

  sharedKeyCredential = serviceClient.credential;
  containerClient = serviceClient.getContainerClient(env.EXPORTS_CONTAINER);
  return containerClient;
}

/** Ensures the exports container exists. Call once at process startup. */
export async function initializeBlobStorage(): Promise<void> {
  const client = getContainerClient();
  await client.createIfNotExists();
  logger.info('Blob storage initialized', { container: env.EXPORTS_CONTAINER });
}

// The explicit index signature keeps this assignable to the SDK's Metadata type.
export interface ExportBlobMetadata {
  [key: string]: string;
  /** User id of the requester, as a string (blob metadata values are strings). */
  requestedby: string;
  projectunitid: string;
}

/**
 * Streams an export ZIP into blob storage without buffering it in memory.
 * Returns the stored blob name and its size.
 */
export async function uploadExportStream(
  jobId: string,
  stream: Readable,
  metadata: ExportBlobMetadata
): Promise<{ filename: string; sizeBytes: number; expiresAt: Date }> {
  const filename = `export-${jobId}.zip`;
  const blockBlobClient = getContainerClient().getBlockBlobClient(filename);

  let sizeBytes = 0;
  const byteCounter = new Transform({
    transform(chunk, _encoding, callback) {
      sizeBytes += chunk.length;
      callback(null, chunk);
    },
  });

  await blockBlobClient.uploadStream(stream.pipe(byteCounter), 4 * 1024 * 1024, 5, {
    blobHTTPHeaders: { blobContentType: 'application/zip' },
    metadata,
  });

  const expiresAt = new Date(Date.now() + EXPORT_TTL_MS);
  logger.info('Export blob uploaded', { filename, sizeBytes, expiresAt });
  return { filename, sizeBytes, expiresAt };
}

export interface ExportBlobInfo {
  metadata: Partial<ExportBlobMetadata>;
  createdOn?: Date;
  contentLength?: number;
}

/** Returns blob metadata, or null when the blob does not exist or has expired. */
export async function getExportBlobInfo(filename: string): Promise<ExportBlobInfo | null> {
  const blobClient = getContainerClient().getBlobClient(filename);
  try {
    const props = await blobClient.getProperties();
    if (props.createdOn && Date.now() - props.createdOn.getTime() > EXPORT_TTL_MS) {
      return null;
    }
    return {
      metadata: (props.metadata ?? {}) as Partial<ExportBlobMetadata>,
      createdOn: props.createdOn,
      contentLength: props.contentLength,
    };
  } catch (error: any) {
    if (error?.statusCode === 404) return null;
    throw error;
  }
}

/** Generates a short-lived read-only SAS URL for a stored export. */
export function generateExportDownloadUrl(filename: string): string {
  const client = getContainerClient();
  if (!sharedKeyCredential) {
    throw new Error('Blob storage credential not initialized');
  }

  const startsOn = new Date(Date.now() - 60 * 1000); // clock-skew allowance
  const expiresOn = new Date(Date.now() + SAS_TTL_MINUTES * 60 * 1000);

  const sas = generateBlobSASQueryParameters(
    {
      containerName: client.containerName,
      blobName: filename,
      permissions: BlobSASPermissions.parse('r'),
      startsOn,
      expiresOn,
    },
    sharedKeyCredential
  ).toString();

  return `${client.getBlobClient(filename).url}?${sas}`;
}

/** Deletes export blobs older than EXPORT_TTL_MS. Safe to call on an interval. */
export async function deleteExpiredExports(): Promise<void> {
  try {
    const client = getContainerClient();
    let deletedCount = 0;

    for await (const blob of client.listBlobsFlat()) {
      const createdOn = blob.properties.createdOn;
      if (createdOn && Date.now() - createdOn.getTime() > EXPORT_TTL_MS) {
        await client.deleteBlob(blob.name);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      logger.info('Cleaned up expired export blobs', { deletedCount });
    }
  } catch (error) {
    logger.error('Failed to clean up expired export blobs', { error });
  }
}
