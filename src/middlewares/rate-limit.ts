import type { Context, Next } from 'hono';

import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppBindings } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';

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

// Under @hono/node-server, c.env carries the raw Node request as `incoming`;
// AppBindings declares no Bindings, so narrow the shape locally.
interface NodeServerEnv {
  incoming?: { socket?: { remoteAddress?: string } };
}

function clientKey(c: Context<AppBindings>): string {
  const trustedHops = env.RATE_LIMIT_TRUSTED_HOPS;

  // No proxy in front of us: x-forwarded-for is entirely client-controlled,
  // so key on the TCP socket address instead.
  if (trustedHops === 0) {
    const socketAddress = (c.env as NodeServerEnv)?.incoming?.socket?.remoteAddress;
    return socketAddress ?? 'unknown';
  }

  // Trust only the proxy-appended tail of x-forwarded-for: each trusted hop
  // APPENDS one entry (Azure App Service appends the real client IP as
  // ip[:port]), so with N trusted hops the client is the Nth entry from the
  // end, while leading entries are client-controlled and spoofable. Requests
  // with no header or fewer entries than trusted hops (e.g. local dev, or a
  // request that bypassed a proxy layer) share one bucket rather than
  // trusting a client-sent value.
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const client = entries[entries.length - trustedHops];
    if (client) return stripPort(client);
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

    // Hard cap on tracked buckets; when full, expired entries are swept and,
    // if necessary, oldest-inserted entries are evicted so memory stays bounded.
    const maxBuckets = env.RATE_LIMIT_MAX_BUCKETS;

    if (!bucket || bucket.resetAt <= now) {
      if (buckets.size >= maxBuckets) {
        for (const [k, b] of buckets) {
          if (b.resetAt <= now) buckets.delete(k);
        }
        // Map iteration order is insertion order, so this evicts oldest first.
        if (buckets.size >= maxBuckets) {
          for (const k of buckets.keys()) {
            buckets.delete(k);
            if (buckets.size < maxBuckets) break;
          }
        }
      }
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
    } else if (bucket.count >= options.max) {
      logger.warn('Rate limit exceeded', {
        client: key,
        path: c.req.path,
        limit: options.max,
        windowMs: options.windowMs,
      });
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return c.json({ message: 'Too many requests' }, HttpStatusCodes.TOO_MANY_REQUESTS);
    } else {
      bucket.count += 1;
    }

    await next();
  };
}
