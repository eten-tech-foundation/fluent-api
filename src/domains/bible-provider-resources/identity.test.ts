import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { ProviderIdentity } from './identity';

import { bibleKey, parseBibleKey } from './identity';

// Neutral fixture cases are independent of either repository's codec implementation.
const cases = JSON.parse(
  readFileSync(
    new URL('../../test/fixtures/bible-provider-identities.json', import.meta.url),
    'utf8'
  )
) as { valid: (ProviderIdentity & { key: string })[]; invalid: string[] };

describe('provider Bible identities', () => {
  it.each(cases.valid)('roundtrips $key', ({ key, provider, externalId }) => {
    expect(parseBibleKey(key)).toEqual({ provider, externalId });
    expect(bibleKey({ provider, externalId })).toBe(key);
  });
  it.each(cases.invalid)('rejects invalid identity %s', (key) => {
    expect(parseBibleKey(key)).toBeNull();
  });
});
