import type { Context, Next } from 'hono';

import { getConnInfo } from '@hono/node-server/conninfo';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import type { AppBindings } from '@/lib/types';

import env from '@/env';
import { logger } from '@/lib/logger';

interface RateLimitOptions {
  /** Window length in milliseconds. Default: env.RATE_LIMIT_WINDOW_MS (60s). */
  windowMs?: number;
  /** Max requests allowed per client within one window. Default: env.RATE_LIMIT_MAX (20). */
  max?: number;
  /**
   * Hard cap on tracked buckets for this limiter instance; when full, expired
   * entries are swept and, if necessary, oldest-inserted entries are evicted
   * so memory stays bounded. Default: env.RATE_LIMIT_MAX_BUCKETS (10k).
   */
  maxBuckets?: number;
  /**
   * How many trusted proxies append to x-forwarded-for in front of this app.
   * 1 = Azure App Service (default), 2 = an extra appending LB in front,
   * 0 = no trusted proxy — ignore the header and key on the socket address.
   * Default: env.RATE_LIMIT_TRUSTED_HOPS.
   */
  trustedHops?: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

// Socket peer address via the node-server adapter; undefined where no socket
// is reachable (non-node transports, bare test contexts).
function socketAddress(c: Context<AppBindings>): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

// Resolve the client key from the deployment's trusted-proxy topology
// (standard proxy-addr semantics): walk [socket, ...x-forwarded-for entries
// right-to-left] and take the entry trustedHops steps out — each trusted
// proxy APPENDS exactly one entry (Azure App Service appends the real client
// IP as ip[:port]), so that position is the closest address a client cannot
// spoof, while leading entries are client-controlled. A chain shorter than
// trustedHops degrades to its furthest (leftmost) available entry.
function clientKey(c: Context<AppBindings>, trustedHops: number): string {
  const forwarded = c.req.header('x-forwarded-for') ?? '';
  const entries = forwarded
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [socketAddress(c) ?? 'unknown', ...entries.reverse()];
  return stripPort(candidates[Math.min(trustedHops, candidates.length - 1)]);
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
 *
 * All options default to the RATE_LIMIT_* env vars (see src/env.ts), so plain
 * `rateLimit()` gives the operator-configured limiter.
 */
export function rateLimit(options: RateLimitOptions = {}) {
  const windowMs = options.windowMs ?? env.RATE_LIMIT_WINDOW_MS;
  const max = options.max ?? env.RATE_LIMIT_MAX;
  const maxBuckets = options.maxBuckets ?? env.RATE_LIMIT_MAX_BUCKETS;
  const trustedHops = options.trustedHops ?? env.RATE_LIMIT_TRUSTED_HOPS;
  const buckets = new Map<string, Bucket>();

  return async (c: Context<AppBindings>, next: Next) => {
    const now = Date.now();
    const key = clientKey(c, trustedHops);
    const bucket = buckets.get(key);

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
      buckets.set(key, { count: 1, resetAt: now + windowMs });
    } else if (bucket.count >= max) {
      logger.warn('Rate limit exceeded', {
        client: key,
        path: c.req.path,
        limit: max,
        windowMs,
      });
      c.header('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      return c.json({ message: 'Too many requests' }, HttpStatusCodes.TOO_MANY_REQUESTS);
    } else {
      bucket.count += 1;
    }

    await next();
  };
}
