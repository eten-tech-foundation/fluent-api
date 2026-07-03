import { describe, expect, it, vi } from 'vitest';

import { server } from '@/server/server';
import '@/routes/config.route';

// Keep import-time side effects quiet; the route itself needs no db/auth.
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

function getFeatures() {
  return server.request('/config/features', { method: 'GET' });
}

describe('gET /config/features', () => {
  it('is unauthenticated — returns 200 with no session/credentials', async () => {
    const res = await getFeatures();
    expect(res.status).toBe(200);
  });

  it('returns a named features map of booleans', async () => {
    const res = await getFeatures();
    const json = await res.json();

    expect(json).toHaveProperty('features');
    expect(typeof json.features).toBe('object');
    for (const value of Object.values(json.features)) {
      expect(typeof value).toBe('boolean');
    }
  });

  it('publishes the repeatedWordCheck flag', async () => {
    const res = await getFeatures();
    const json = await res.json();

    // .env.test wires FLUENT_AI_URL + FLUENT_AI_KEY and leaves the flag unset,
    // so the derived (safe) default resolves to true in the test env.
    expect(json.features).toHaveProperty('repeatedWordCheck');
    expect(json.features.repeatedWordCheck).toBe(true);
  });
});
