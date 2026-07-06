export const POSTGRES_FTS_LANGUAGES: Record<string, string> = {
  eng: 'english',
  en: 'english',
  spa: 'spanish',
  es: 'spanish',
  fre: 'french',
  fra: 'french',
  fr: 'french',
  ger: 'german',
  deu: 'german',
  de: 'german',
  ita: 'italian',
  it: 'italian',
  por: 'portuguese',
  pt: 'portuguese',
  rus: 'russian',
  ru: 'russian',
  hin: 'simple',
  guj: 'simple',
  mar: 'simple',
  ben: 'simple',
  tam: 'simple',
};

export function getFtsConfig(languageCode: string | null): string {
  if (!languageCode) return 'simple';
  return POSTGRES_FTS_LANGUAGES[languageCode.toLowerCase()] || 'simple';
}

export const BIBLE_BOOK_GROUPS: Record<string, string[]> = {
  gospel_narrative: ['MAT', 'MRK', 'LUK', 'JHN'],
  jesus_parables: ['MAT', 'MRK', 'LUK'],
  johannine_writings: ['JHN', '1JN', '2JN', '3JN', 'REV'],
  lukan_writings: ['LUK', 'ACT'],
  pauline_theology: ['ROM', '1CO', '2CO', 'GAL', 'EPH', 'PHP', 'COL'],
  pastoral_epistles: ['1TI', '2TI', 'TIT'],
  prison_epistles: ['EPH', 'PHP', 'COL', 'PHM'],
  wisdom_literature: ['JOB', 'PSA', 'PRO', 'ECC', 'SNG'],
  major_prophetic_style: ['ISA', 'JER', 'EZK', 'DAN'],
  minor_prophetic_style: [
    'HOS',
    'JOL',
    'AMO',
    'OBA',
    'JON',
    'MIC',
    'NAM',
    'HAB',
    'ZEP',
    'HAG',
    'ZEC',
    'MAL',
  ],
  torah_legal_language: ['GEN', 'EXO', 'LEV', 'NUM', 'DEU'],
  kingdom_history: ['1SA', '2SA', '1KI', '2KI', '1CH', '2CH'],
  post_exilic_history: ['EZR', 'NEH', 'EST'],
  exile_and_restoration: ['JER', 'EZK', 'DAN', 'EZR', 'NEH'],
  messianic_prophecy: ['ISA', 'MIC', 'ZEC', 'PSA'],
  church_history_and_mission: ['LUK', 'ACT'],
  suffering_and_endurance: ['JOB', '1PE', 'JAS', 'HEB'],
  worship_and_prayer: ['PSA'],
  love_and_relationship_poetry: ['SNG'],
};

export const RECOMMENDED_STRATEGIES: Record<string, string[]> = {
  MAT: BIBLE_BOOK_GROUPS.gospel_narrative,
  MRK: BIBLE_BOOK_GROUPS.gospel_narrative,
  LUK: ['LUK', 'ACT', 'MAT', 'MRK'],
  JHN: BIBLE_BOOK_GROUPS.johannine_writings,
  ACT: BIBLE_BOOK_GROUPS.lukan_writings,
  ROM: BIBLE_BOOK_GROUPS.pauline_theology,
  '1CO': BIBLE_BOOK_GROUPS.pauline_theology,
  '2CO': BIBLE_BOOK_GROUPS.pauline_theology,
  GAL: BIBLE_BOOK_GROUPS.pauline_theology,
  EPH: BIBLE_BOOK_GROUPS.pauline_theology,
  PHP: BIBLE_BOOK_GROUPS.pauline_theology,
  COL: BIBLE_BOOK_GROUPS.pauline_theology,
  '1TI': BIBLE_BOOK_GROUPS.pastoral_epistles,
  '2TI': BIBLE_BOOK_GROUPS.pastoral_epistles,
  TIT: BIBLE_BOOK_GROUPS.pastoral_epistles,
  PHM: BIBLE_BOOK_GROUPS.prison_epistles,
  ISA: BIBLE_BOOK_GROUPS.major_prophetic_style,
  JER: BIBLE_BOOK_GROUPS.major_prophetic_style,
  EZK: BIBLE_BOOK_GROUPS.major_prophetic_style,
  DAN: BIBLE_BOOK_GROUPS.major_prophetic_style,
  ZEC: BIBLE_BOOK_GROUPS.minor_prophetic_style,
  JOB: BIBLE_BOOK_GROUPS.wisdom_literature,
  PSA: BIBLE_BOOK_GROUPS.wisdom_literature,
  PRO: BIBLE_BOOK_GROUPS.wisdom_literature,
  ECC: BIBLE_BOOK_GROUPS.wisdom_literature,
  SNG: BIBLE_BOOK_GROUPS.wisdom_literature,
  GEN: BIBLE_BOOK_GROUPS.torah_legal_language,
  EXO: BIBLE_BOOK_GROUPS.torah_legal_language,
  LEV: BIBLE_BOOK_GROUPS.torah_legal_language,
  NUM: BIBLE_BOOK_GROUPS.torah_legal_language,
  DEU: BIBLE_BOOK_GROUPS.torah_legal_language,
};

export function getContextBookCodes(targetBookCode: string): string[] {
  const code = targetBookCode.toUpperCase();

  if (code in RECOMMENDED_STRATEGIES) {
    return RECOMMENDED_STRATEGIES[code];
  }

  for (const group of Object.values(BIBLE_BOOK_GROUPS)) {
    if (group.includes(code)) {
      return group;
    }
  }

  return [code];
}
