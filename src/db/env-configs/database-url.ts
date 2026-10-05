import type { EnvConfig } from './types';

/**
 * Applies the env-config's `databaseUrl` to `process.env.DATABASE_URL`,
 * falling back to whatever the environment already provides (docker-compose
 * injects it for local). The env-config value always wins so an env-specific
 * URL can't be silently overridden by a generic `DATABASE_URL` exported in
 * the shell.
 *
 * Must run BEFORE importing anything that touches the db client — the client
 * reads `DATABASE_URL` at import time.
 *
 * Returns the URL masked for logging, or null when no URL is available.
 */
export function applyDatabaseUrl(config: Pick<EnvConfig, 'databaseUrl'>): string | null {
  const url = config.databaseUrl ?? process.env.DATABASE_URL;
  if (!url) return null;
  process.env.DATABASE_URL = url;
  return url.replace(/:([^@]+)@/, ':****@');
}
