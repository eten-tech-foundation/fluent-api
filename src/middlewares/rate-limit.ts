import type { Context, Next } from 'hono';

import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppBindings } from '@/lib/types';

interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max requests allowed per client within one window. */
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

// Sweep expired buckets once the map grows past this, to bound memory.
const CLEANUP_THRESHOLD = 5000;

function clientKey(c: Context<AppBindings>): string {
  // Azure App Service (and most proxies) set x-forwarded-for; the first entry
  // is the original client. Fall back to a shared bucket rather than failing
  // open per-request — this limiter is an abuse guard, not a billing quota.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

/**
 * Minimal fixed-window, per-client-IP rate limiter for anonymous endpoints.
 * State is in-memory (per process), so limits apply per instance — sufficient
 * as a scraping/abuse guard for intentionally unauthenticated routes. better-auth
 * rate-limits /api/auth/* separately; this covers everything else.
 */
export function rateLimit(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();

  return async (c: Context<AppBindings>, next: Next) => {
    const now = Date.now();
    const key = clientKey(c);
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (bucket.count >= options.max) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return c.json({ message: 'Too many requests' }, HttpStatusCodes.TOO_MANY_REQUESTS);
    } else {
      bucket.count += 1;
    }

    if (buckets.size > CLEANUP_THRESHOLD) {
      for (const [k, b] of buckets) {
        if (b.resetAt <= now) buckets.delete(k);
      }
    }

    await next();
  };
}
