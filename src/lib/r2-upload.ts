/**
 * r2-upload.ts
 *
 * Server-side Cloudflare R2 upload using AWS Signature V4.
 * Uses Node's native `node:crypto` — no external packages or hand-rolled crypto.
 *
 * Credentials are read from the validated env schema (never hardcoded).
 */

import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';

import env from '@/env';
import { logger } from '@/lib/logger';

// ─── Crypto helpers ───────────────────────────────────────────────────────────

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: Buffer | string, data: string): Buffer {
  const keyBuf = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  return createHmac('sha256', keyBuf).update(data, 'utf8').digest();
}

function toHex(buf: Buffer): string {
  return buf.toString('hex');
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function getAmzTimestamps(now: Date): { dateStamp: string; amzDate: string } {
  const dateStamp =
    `${now.getUTCFullYear()}` + `${pad2(now.getUTCMonth() + 1)}` + `${pad2(now.getUTCDate())}`;

  const amzDate =
    `${dateStamp}T` +
    `${pad2(now.getUTCHours())}` +
    `${pad2(now.getUTCMinutes())}` +
    `${pad2(now.getUTCSeconds())}Z`;

  return { dateStamp, amzDate };
}

// ─── SigV4 builder ────────────────────────────────────────────────────────────

function buildAuthorizationHeader(params: {
  method: string;
  host: string;
  urlPath: string;
  contentType: string;
  payloadHash: string;
  amzDate: string;
  dateStamp: string;
  accessKeyId: string;
  secretAccessKey: string;
}): string {
  const {
    method,
    host,
    urlPath,
    contentType,
    payloadHash,
    amzDate,
    dateStamp,
    accessKeyId,
    secretAccessKey,
  } = params;

  const region = 'auto';
  const service = 's3';
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';

  // Canonical headers must be sorted alphabetically by header name
  const canonicalHeaders =
    `content-type:${contentType}\n` +
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    method,
    urlPath,
    '', // query string (empty for direct PUT)
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Derive signing key
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = toHex(hmacSha256(kSigning, stringToSign));

  return (
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  );
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Uploads a binary buffer to Cloudflare R2 using AWS Signature V4.
 *
 * @param buffer      The raw audio file content.
 * @param r2Key       Object key in the bucket (used verbatim — must be the
 *                    `relative_path` sent by the mobile client).
 * @param contentType MIME type, e.g. 'audio/mp4'. Defaults to 'audio/mp4'.
 *
 * @throws Error with the R2 error body if the upload is rejected.
 */
export async function uploadToR2(
  buffer: Buffer,
  r2Key: string,
  contentType: string = 'audio/mp4'
): Promise<void> {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET_NAME;

  const host = `${accountId}.r2.cloudflarestorage.com`;

  // Encode each path segment individually to preserve slashes as separators
  const encodedKey = r2Key.split('/').map(encodeURIComponent).join('/');

  const urlPath = `/${bucket}/${encodedKey}`;
  const url = `https://${host}${urlPath}`;

  const { dateStamp, amzDate } = getAmzTimestamps(new Date());
  const payloadHash = sha256Hex(buffer);

  const authorization = buildAuthorizationHeader({
    method: 'PUT',
    host,
    urlPath,
    contentType,
    payloadHash,
    amzDate,
    dateStamp,
    accessKeyId,
    secretAccessKey,
  });

  logger.info('Uploading to R2', {
    r2Key,
    contentType,
    sizeBytes: buffer.length,
    bucket,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: authorization,
      },
      body: buffer,
      signal: controller.signal,
    });
  } catch (networkError) {
    logger.error('R2 network request failed', { r2Key, error: networkError });
    throw new Error(
      `R2 network error: ${networkError instanceof Error ? networkError.message : String(networkError)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '(could not read response body)');
    logger.error('R2 rejected upload', {
      r2Key,
      status: response.status,
      statusText: response.statusText,
      errorBody,
    });
    throw new Error(`R2 upload failed [HTTP ${response.status}]: ${errorBody}`);
  }

  logger.info('R2 upload successful', { r2Key, sizeBytes: buffer.length });
}
