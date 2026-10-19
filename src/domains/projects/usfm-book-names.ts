/**
 * Names a USFM file may give its book where the `\id` code is missing (#418). The book is then
 * read from `\toc3` (the short abbreviation) or `\mt` (the main title), and those usually hold a
 * name rather than a code: "Obad" or "Obadiah" in an English file, "ओब." or "ओबद्याह" in a
 * Hindi one.
 *
 * Codes are tried before this table (Door43's IRV writes `\toc3 oba`), so only names that are
 * not codes are listed. English has the usual title spellings and SBL-style abbreviations. Hindi
 * has every distinct `\h`, `\toc1`, `\toc2`, `\toc3` and `\mt1` of the Hindi IRV (eBible
 * `hin2017` and Door43 `hi_irv`), the files QA imports. Another language is added the same way:
 * append its names to each book.
 */
export const BOOK_NAMES: Readonly<Record<string, readonly string[]>> = {
  GEN: ['Genesis', 'Gn', 'उत्पत्ति', 'उत्प.'],
  EXO: ['Exodus', 'Exod', 'Ex', 'निर्गमन', 'निर्ग.'],
  LEV: ['Leviticus', 'Lv', 'लैव्यव्यवस्था', 'लैव्य.'],
  NUM: ['Numbers', 'Nm', 'गिनती', 'गिन.'],
  DEU: ['Deuteronomy', 'Deut', 'Dt', 'व्यवस्थाविवरण', 'व्यव.'],
  JOS: ['Joshua', 'Josh', 'यहोशू', 'यहो.'],
  JDG: ['Judges', 'Judg', 'Jgs', 'न्यायियों', 'न्याय.'],
  RUT: ['Ruth', 'Ru', 'Rth', 'रूत'],
  '1SA': ['1 Samuel', '1 Sam', '1 Sm', '1 शमूएल', 'शमूएल की पहली पुस्तक', '1 शमू.'],
  '2SA': ['2 Samuel', '2 Sam', '2 Sm', '2 शमूएल', 'शमूएल की दूसरी पुस्तक', '2 शमू.'],
  '1KI': ['1 Kings', '1 Kgs', '1 राजाओं', 'राजाओं की पहली पुस्तक', '1 राजा.'],
  '2KI': ['2 Kings', '2 Kgs', '2 राजाओं', 'राजाओं की दूसरी पुस्तक', '2 राजा.'],
  '1CH': ['1 Chronicles', '1 Chr', '1 Chron', '1 इतिहास', 'इतिहास की पहली पुस्तक', '1 इति.'],
  '2CH': ['2 Chronicles', '2 Chr', '2 Chron', '2 इतिहास', 'इतिहास की दूसरी पुस्तक', '2 इति.'],
  EZR: ['Ezra', 'एज्रा'],
  NEH: ['Nehemiah', 'नहेम्याह', 'नहे.'],
  EST: ['Esther', 'Esth', 'एस्तेर', 'एस्ते.'],
  JOB: ['अय्यूब', 'अय्यू.'],
  PSA: ['Psalms', 'Psalm', 'Ps', 'Pss', 'भजन संहिता', 'भज.'],
  PRO: ['Proverbs', 'Prov', 'Prv', 'नीतिवचन', 'नीति.'],
  ECC: ['Ecclesiastes', 'Eccl', 'Eccles', 'Qoheleth', 'Qoh', 'सभोपदेशक', 'सभो.'],
  SNG: ['Song of Solomon', 'Song of Songs', 'Song', 'Canticles', 'Cant', 'श्रेष्ठगीत', 'श्रेष्ठ.'],
  ISA: ['Isaiah', 'Is', 'यशायाह', 'यशा.'],
  JER: ['Jeremiah', 'यिर्मयाह', 'यिर्म.'],
  LAM: ['Lamentations', 'विलापगीत', 'विला.'],
  EZK: ['Ezekiel', 'Ezek', 'Ez', 'यहेजकेल', 'यहे.'],
  DAN: ['Daniel', 'Dn', 'दानिय्येल', 'दानि.'],
  HOS: ['Hosea', 'होशे'],
  JOL: ['Joel', 'Jl', 'योएल', 'योए.'],
  AMO: ['Amos', 'Am', 'आमोस', 'आमो.'],
  OBA: ['Obadiah', 'Obad', 'Ob', 'ओबद्याह', 'ओब.'],
  JON: ['Jonah', 'Jnh', 'योना'],
  MIC: ['Micah', 'मीका'],
  NAM: ['Nahum', 'Nah', 'नहूम', 'नहू.'],
  HAB: ['Habakkuk', 'हबक्कूक', 'हब.'],
  ZEP: ['Zephaniah', 'Zeph', 'सपन्याह', 'सप.'],
  HAG: ['Haggai', 'हाग्गै'],
  ZEC: ['Zechariah', 'Zech', 'जकर्याह', 'जक.'],
  MAL: ['Malachi', 'मलाकी', 'मला.'],
  MAT: ['Matthew', 'Matt', 'Mt', 'मत्ती', 'मत्ती रचित सुसमाचार'],
  MRK: ['Mark', 'Mk', 'मरकुस', 'मरकुस रचित सुसमाचार', 'मर.'],
  LUK: ['Luke', 'Lk', 'लूका', 'लूका रचित सुसमाचार'],
  JHN: ['John', 'Jn', 'यूहन्ना', 'यूहन्ना रचित सुसमाचार', 'यूह.'],
  ACT: ['Acts', 'Acts of the Apostles', 'प्रेरितों के काम', 'प्रेरि.'],
  ROM: ['Romans', 'रोमियों', 'रोमियों के नाम पौलुस प्रेरित की पत्री', 'रोम.'],
  '1CO': [
    '1 Corinthians',
    '1 Cor',
    '1 कुरिन्थियों',
    'कुरिन्थियों के नाम पौलुस प्रेरित की पहली पत्री',
    '1कुरि.',
    'कुरिन्थ की कलीसिया को लिखा गया पौलुस का पहला पत्र',
  ],
  '2CO': [
    '2 Corinthians',
    '2 Cor',
    '2 कुरिन्थियों',
    'कुरिन्थियों के नाम पौलुस प्रेरित की दूसरी पत्री',
    '2कुरि.',
    'कुरिन्थ की कलीसिया को लिखा गया पौलुस का दूसरा पत्र',
  ],
  GAL: ['Galatians', 'गलातियों', 'गलातियों के नाम पौलुस प्रेरित की पत्री', 'गला.'],
  EPH: ['Ephesians', 'इफिसियों', 'इफिसियों के नाम पौलुस प्रेरित की पत्री', 'इफि.'],
  PHP: ['Philippians', 'Phil', 'फिलिप्पियों', 'फिलिप्पियों के नाम पौलुस प्रेरित की पत्री', 'फिलि.'],
  COL: ['Colossians', 'कुलुस्सियों', 'कुलुस्सियों के नाम पौलुस प्रेरित की पत्री', 'कुलु.'],
  '1TH': [
    '1 Thessalonians',
    '1 Thess',
    '1 Thes',
    '1 थिस्सलुनीकियों',
    'थिस्सलुनीकियों के नाम पौलुस प्रेरित की पहली पत्री',
    '1थिस्स.',
  ],
  '2TH': [
    '2 Thessalonians',
    '2 Thess',
    '2 Thes',
    '2 थिस्सलुनीकियों',
    'थिस्सलुनीकियों के नाम पौलुस प्रेरित की दूसरी पत्री',
    '2 थिस्स.',
  ],
  '1TI': [
    '1 Timothy',
    '1 Tim',
    '1 तीमुथियुस',
    'तीमुथियुस के नाम प्रेरित पौलुस की पहली पत्री',
    '1 तीमु.',
  ],
  '2TI': [
    '2 Timothy',
    '2 Tim',
    '2 तीमुथियुस',
    'तीमुथियुस के नाम प्रेरित पौलुस की दूसरी पत्री',
    '2 तीमु.',
  ],
  TIT: ['Titus', 'तीतुस', 'तीतुस के नाम प्रेरित पौलुस की पत्री', 'तीतु.'],
  PHM: ['Philemon', 'Phlm', 'Philem', 'फिलेमोन', 'फिलेमोन के नाम प्रेरित पौलुस की पत्री', 'फिले.'],
  HEB: ['Hebrews', 'इब्रानियों', 'इब्रानियों के नाम पत्री', 'इब्रा.'],
  JAS: ['James', 'Jm', 'याकूब', 'याकूब की पत्री', 'याकू.'],
  '1PE': ['1 Peter', '1 Pet', '1 Pt', '1 पतरस', 'पतरस की पहली पत्री', '1 पत.'],
  '2PE': ['2 Peter', '2 Pet', '2 Pt', '2 पतरस', 'पतरस की दूसरी पत्री', '2 पत.'],
  '1JN': ['1 John', '1 Jn', '1 यूहन्ना', 'यूहन्ना की पहली पत्री', '1 यूह.'],
  '2JN': ['2 John', '2 Jn', '2 यूहन्ना', 'यूहन्ना की दूसरी पत्री', '2 यूह.'],
  '3JN': ['3 John', '3 Jn', '3 यूहन्ना', 'यूहन्ना की तीसरी पत्री', '3 यूह.'],
  JUD: ['Jude', 'यहूदा', 'यहूदा की पत्री', 'यहू.'],
  REV: [
    'Revelation',
    'Revelation of John',
    'Apocalypse',
    'Rv',
    'प्रकाशितवाक्य',
    'यूहन्ना का प्रकाशितवाक्य',
    'प्रका.',
  ],
};

/** Spelled-out and Roman ordinals, so "First Samuel" and "I Samuel" read as "1 Samuel". */
const ORDINALS: Readonly<Record<string, string>> = {
  i: '1',
  first: '1',
  '1st': '1',
  ii: '2',
  second: '2',
  '2nd': '2',
  iii: '3',
  third: '3',
  '3rd': '3',
};

/** Words an English title wraps around a book name: "The Gospel According to St. John". */
const FILLER_WORDS = new Set([
  'the',
  'book',
  'of',
  'to',
  'gospel',
  'according',
  'saint',
  'st',
  'letter',
  'epistle',
  'general',
  'paul',
  'apostle',
]);

const DEVANAGARI_ZERO = 0x966;

/** "१ इतिहास" reads as "1 इतिहास": Devanagari digits become ASCII ones. */
function asciiDigits(text: string): string {
  return Array.from(text, (char) => {
    const digit = (char.codePointAt(0) ?? 0) - DEVANAGARI_ZERO;
    return digit >= 0 && digit <= 9 ? String(digit) : char;
  }).join('');
}

/**
 * Folds a name to the form the table is looked up by: NFC, lower case, ASCII digits, no
 * punctuation or spaces ("1 इति." and "1इति" meet), ordinals as digits and filler words gone.
 */
export function normalizeBookName(name: string): string {
  return asciiDigits(name.normalize('NFC').toLowerCase())
    .split(/[\s.,:;'’()]+/)
    .filter(Boolean)
    .map((word) => ORDINALS[word] ?? word)
    .filter((word) => !FILLER_WORDS.has(word))
    .join('');
}

const CODE_BY_NAME = new Map(
  Object.entries(BOOK_NAMES).flatMap(([code, names]) =>
    names.map((name) => [normalizeBookName(name), code] as const)
  )
);

/**
 * The book a `\toc3` or `\mt` text names, if it is one of `knownCodes`: its first word when that
 * is a code, otherwise the whole text looked up as a name.
 */
export function bookCodeFromName(
  text: string,
  knownCodes: ReadonlySet<string>
): string | undefined {
  const firstWord = text.trim().split(/\s+/)[0]?.toUpperCase();
  if (firstWord && knownCodes.has(firstWord)) return firstWord;

  const code = CODE_BY_NAME.get(normalizeBookName(text));
  return code !== undefined && knownCodes.has(code) ? code : undefined;
}
