/**
 * Identities of the seeded reference bibles, shared by seeds/bibles.ts (which
 * owns their provider-resource rows) and the demo spec (which must declare
 * them to resolve projects' sourceBible by upstream identity). db-free so the
 * spec modules stay unit-testable.
 */

export const IRV_BIBLE = {
  name: 'IRV Gujarati',
  abbreviation: 'IRV',
  languageCode: 'guj',
  // API.Bible catalogue ids (public identifiers, not credentials): the text
  // bible and its selected audio recording — real Gujarati IRV audio.
  externalId: 'a3644a98420c2703-01',
  audioExternalId: '2abea5341ec34814-01',
  licenseNotice: 'Indian Revised Version (IRV) © 2019 Bridge Connectivity Solutions. CC BY-SA 4.0.',
} as const;

export const IRV_BOOK_CODES = ['GEN', 'EXO'] as const;

// Offline text fixture is DBL BSB; its explicitly selected recording is Aquifer BSB.
export const BSB_BIBLE = {
  name: 'Berean Standard Bible',
  abbreviation: 'BSB',
  languageCode: 'eng',
  externalId: 'bba9f40183526463-01',
} as const;

export const BSB_BOOK_CODES = ['JHN'] as const;

/**
 * The catalogue sync's suffix shape for abbreviation collisions
 * (dbl-bible-sync.ts): `${base}-${externalId-prefix}` capped at the column's
 * 50 chars, base capped at 40 to leave room for the suffix. The sync itself
 * dedupes case-insensitively inside a batch and appends a `-N` counter on
 * repeat collisions — seeds don't need either: they resolve collisions by
 * upstream identity and throw only on a genuine second collision.
 */
export function suffixedAbbreviation(abbreviation: string, externalId: string): string {
  return `${abbreviation.slice(0, 40)}-${externalId.slice(0, 6)}`.slice(0, 50);
}
