import type { Provider, ProviderIdentity } from './bible-provider-resources.types';

export const BIBLE_PROVIDER_PREFIXES = {
  aquifer: 'aq',
  youversion: 'yv',
  dbl: 'dbl',
} as const satisfies Record<Provider, string>;

export function parseBibleKey(key: string): ProviderIdentity | null {
  const match = /^(aq|yv|dbl)-(.+)$/.exec(key);
  if (!match) return null;
  const [, prefix, externalId] = match;
  if (
    !externalId ||
    externalId.trim() !== externalId ||
    externalId.length > 255 ||
    Array.from(externalId).some(
      (char) => char.charCodeAt(0) < 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159)
    )
  )
    return null;
  if (
    prefix !== 'dbl' &&
    (!/^[1-9]\d*$/.test(externalId) || !Number.isSafeInteger(Number(externalId)))
  )
    return null;
  // IDs are opaque, never a URL to fetch.
  if (externalId.includes('://')) return null;
  const provider = Object.entries(BIBLE_PROVIDER_PREFIXES).find(
    ([, candidatePrefix]) => candidatePrefix === prefix
  )?.[0] as Provider | undefined;
  return provider ? { provider, externalId } : null;
}

export function bibleKey(identity: ProviderIdentity): string {
  return `${BIBLE_PROVIDER_PREFIXES[identity.provider]}-${identity.externalId}`;
}
