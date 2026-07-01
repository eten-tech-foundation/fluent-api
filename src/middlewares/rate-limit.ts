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

// Hard cap on tracked buckets; when full, expired entries are swept and, if
// necessary, oldest-inserted entries are evicted so memory stays bounded.
const MAX_BUCKETS = 10_000;

function clientKey(c: Context<AppBindings>): string {
  // Trust only the proxy-appended tail of x-forwarded-for: Azure App Service
  // APPENDS the real client IP (as ip[:port]) to whatever the caller sent, so
  // the LAST entry comes from our trusted front-end while leading entries are
  // client-controlled and spoofable. Requests that arrive without a proxy
  // (local dev) share one bucket rather than trusting a client-sent header.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const last = entries[entries.length - 1];
    if (last) return stripPort(last);
  }
  return 'unknown';
}

// App Service formats IPv4 entries as "ip:port"; bracketed IPv6 as "[::1]:port".
// Bare IPv6 addresses contain multiple colons and are returned unchanged.
function stripPort(entry: string): string {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    return end === -1 ? entry : entry.slice(1, end);
  }
  const parts = entry.split(':');
  return parts.length === 2 ? parts[0] : entry;
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
      if (buckets.size >= MAX_BUCKETS) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= now) buckets.delete(k);
        }
        // Map iteration order is insertion order, so this evicts oldest first.
        if (buckets.size >= MAX_BUCKETS) {
          for (const k of buckets.keys()) {
            buckets.delete(k);
            if (buckets.size < MAX_BUCKETS) break;
          }
        }
      }
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (bucket.count >= options.max) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return c.json({ message: 'Too many requests' }, HttpStatusCodes.TOO_MANY_REQUESTS);
    } else {
      bucket.count += 1;
    }

    await next();
  };
}
