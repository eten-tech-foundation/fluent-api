import { z } from 'zod';

import type { DblBible, DblBook, DblChapter, DblVerse } from './types';

import env from '../../env';
import { logger } from '../logger';
import {
  createDblResponseSchema,
  DblBibleSchema,
  DblBookSchema,
  DblChapterSchema,
  DblVerseSchema,
} from './types';

/**
 * HTTP client for the DBL / API.Bible REST API.
 *
 * All requests are authenticated via the `api-key` header using the key
 * from `env.DBL_API_KEY`. The client includes built-in resilience:
 *
 * - **Exponential backoff with jitter:** On retryable errors (429 rate limit,
 *   5xx server errors, network failures), the client waits 1s, 2s, 4s (plus
 *   random jitter up to 500ms) before retrying. Maximum 3 retries.
 * - **Strict Zod validation:** Every API response is parsed through a Zod
 *   schema before being returned. If the API contract changes, we fail fast
 *   with a ZodError rather than silently corrupting data.
 * - **Non-retryable short-circuit:** Client errors (400, 401, 403, 404) are
 *   thrown immediately without retrying, since they will never succeed.
 *
 * Usage:
 * ```typescript
 * const client = new DblClient();
 * const bibles = await client.getBibles();
 * const books = await client.getBooks(bibles[0].id);
 * ```
 */
export class DblClient {
  private baseUrl: string;
  private apiKey: string;
  private maxRetries = 3;

  /** HTTP status codes that are safe to retry (transient failures). */
  private static RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

  constructor() {
    this.baseUrl = env.DBL_API_BASE_URL;
    this.apiKey = env.DBL_API_KEY;
  }

  /** Promise-based sleep utility for backoff delays. */
  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Makes an HTTP GET request with automatic retry and Zod validation.
   *
   * Only retries on transient/retryable errors (429, 5xx, network failures).
   * Client errors (4xx except 429) and Zod validation failures are thrown
   * immediately since retrying them would be pointless.
   */
  private async fetchWithRetry<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    if (!this.apiKey) {
      throw new Error('DBL_API_KEY is not configured');
    }

    const url = `${this.baseUrl}${path}`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            'api-key': this.apiKey,
            'Content-Type': 'application/json',
          },
        });

        if (!response.ok) {
          const errorMsg = `DBL API error: ${response.status} ${response.statusText}`;

          // Only retry on transient/retryable HTTP status codes.
          // Client errors (400, 401, 403, 404) will never succeed on retry.
          if (DblClient.RETRYABLE_STATUS_CODES.has(response.status)) {
            throw new Error(errorMsg);
          }

          // Non-retryable client error — throw immediately, skip remaining retries.
          throw Object.assign(new Error(errorMsg), { retryable: false });
        }

        const json = await response.json();
        const parsed = schema.parse(json);
        return parsed;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry non-retryable errors (client 4xx, Zod validation failures).
        const isNonRetryable =
          (lastError as any).retryable === false || lastError.name === 'ZodError';
        if (isNonRetryable) {
          throw lastError;
        }

        if (attempt < this.maxRetries) {
          // Exponential backoff: 1s, 2s, 4s (plus up to 500ms random jitter
          // to prevent thundering herd when multiple workers hit the limit).
          const backoff = 2 ** attempt * 1000 + Math.random() * 500;
          logger.warn(`DBL API request failed, retrying in ${Math.round(backoff)}ms`, {
            path,
            attempt: attempt + 1,
            error: lastError.message,
          });
          await this.sleep(backoff);
        }
      }
    }

    throw lastError;
  }

  // ─── Public API Methods ──────────────────────────────────────────────────

  /** Fetches the full catalogue of available Bibles. */
  async getBibles(): Promise<DblBible[]> {
    const schema = createDblResponseSchema(z.array(DblBibleSchema));
    const res = await this.fetchWithRetry('/bibles', schema);
    return res.data;
  }

  /** Fetches metadata for a single Bible by its DBL ID. */
  async getBible(bibleId: string): Promise<DblBible> {
    const schema = createDblResponseSchema(DblBibleSchema);
    const res = await this.fetchWithRetry(`/bibles/${bibleId}`, schema);
    return res.data;
  }

  /** Fetches all books belonging to a specific Bible. */
  async getBooks(bibleId: string): Promise<DblBook[]> {
    const schema = createDblResponseSchema(z.array(DblBookSchema));
    const res = await this.fetchWithRetry(`/bibles/${bibleId}/books`, schema);
    return res.data;
  }

  /** Fetches all chapters for a specific book within a Bible. */
  async getChapters(bibleId: string, bookId: string): Promise<DblChapter[]> {
    const schema = createDblResponseSchema(z.array(DblChapterSchema));
    const res = await this.fetchWithRetry(`/bibles/${bibleId}/books/${bookId}/chapters`, schema);
    return res.data;
  }

  /** Fetches all verses for a specific chapter within a Bible. */
  async getVerses(bibleId: string, chapterId: string): Promise<DblVerse[]> {
    const schema = createDblResponseSchema(z.array(DblVerseSchema));
    const res = await this.fetchWithRetry(
      `/bibles/${bibleId}/chapters/${chapterId}/verses`,
      schema
    );
    return res.data;
  }
}
