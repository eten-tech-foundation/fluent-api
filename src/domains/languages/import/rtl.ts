/**
 * Script names matched against the Ethnologue English language name.
 * Catches language families like "Arabic, Baharna" or "Hebrew".
 * Source: issue #225 spec.
 */
const RTL_NAME_KEYWORDS = [
  'arabic',
  'hebrew',
  'syriac',
  'thaana',
  "n'ko",
  'adlam',
  'hanifi rohingya',
  'mandaic',
  'mende kikakui',
  'samaritan',
  'yezidi',
  'old hungarian',
];

/**
 * Explicit ISO 639-3 codes for RTL languages whose English name doesn't
 * contain any of the keywords above (e.g. "Urdu" uses Arabic script but the
 * name doesn't contain "Arabic"). Best-effort — script direction is
 * definitively confirmed during DBL Bible ingestion (see issue #230).
 */
const RTL_CODES = new Set([
  'urd', // Urdu
  'fas',
  'pes',
  'prs', // Persian / Dari
  'pbt',
  'pbu',
  'pst', // Pashto variants
  'ckb',
  'sdh', // Kurdish (Sorani / Southern)
  'snd', // Sindhi
  'div', // Dhivehi (Maldivian)
  'uig', // Uyghur
  'kas', // Kashmiri
  'bal',
  'bcc',
  'bgn',
  'bgp', // Balochi variants
  'skr', // Saraiki
  'brh', // Brahui
  'haz', // Hazaragi
]);

export function isRTL(code: string, name: string): boolean {
  const lowerName = name.toLowerCase();
  return RTL_CODES.has(code) || RTL_NAME_KEYWORDS.some((keyword) => lowerName.includes(keyword));
}
