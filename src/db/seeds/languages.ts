import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { languages } from '@/db/schema';

// ─── Constants ───────────────────────────────────────────────────────────────

const DATA_FOLDER = './data/language-data';
const CHUNK_SIZE = 1000;
const MAX_FIELD_LENGTH = 100; // matches varchar(100) in schema

/**
 * Script names matched against the Ethnologue English language name.
 * Catches language families like "Arabic, Baharna" or "Hebrew".
 * Source: project spec.
 */
const RTL_NAME_KEYWORDS = [
  'Arabic',
  'Hebrew',
  'Syriac',
  'Thaana',
  "N'Ko",
  'Adlam',
  'Hanifi Rohingya',
  'Mandaic',
  'Mende Kikakui',
  'Samaritan',
  'Yezidi',
  'Old Hungarian',
];

/**
 * Explicit ISO 639-3 codes for RTL languages whose English names
 * don't contain any of the keywords above (e.g., "Urdu" uses Arabic script
 * but the name doesn't contain "Arabic").
 *
 * Note: This is a best-effort list. Script direction will be definitively
 * confirmed during DBL Bible ingestion (see #230).
 */
const RTL_CODES = new Set([
  // Urdu
  'urd',
  // Persian / Dari
  'fas',
  'pes',
  'prs',
  // Pashto variants
  'pbt',
  'pbu',
  'pst',
  // Kurdish (Sorani / Southern)
  'ckb',
  'sdh',
  // Sindhi
  'snd',
  // Dhivehi (Maldivian)
  'div',
  // Uyghur
  'uig',
  // Kashmiri
  'kas',
  // Balochi variants
  'bal',
  'bcc',
  'bgn',
  'bgp',
  // Saraiki
  'skr',
  // Brahui
  'brh',
  // Hazaragi
  'haz',
]);

function isRTL(code: string, name: string): boolean {
  return RTL_CODES.has(code) || RTL_NAME_KEYWORDS.some((kw) => name.includes(kw));
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.substring(0, max) : value;
}

// ─── CSV Parsing ─────────────────────────────────────────────────────────────

function detectDelimiter(headerLine: string): string {
  return headerLine.includes('\t') ? '\t' : ',';
}

/**
 * Parses a single CSV/TSV line, correctly handling quoted fields
 * and escaped quotes regardless of delimiter.
 */
function parseLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

/**
 * Reads a CSV/TSV file and returns parsed headers + rows.
 * Delimiter is auto-detected from the header line.
 */
function readCsvFile(filePath: string): {
  headers: string[];
  rows: string[][];
  delimiter: string;
} {
  const raw = readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { headers: [], rows: [], delimiter: ',' };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseLine(lines[0], delimiter).map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line) => parseLine(line.trim(), delimiter));

  return { headers, rows, delimiter };
}

// ─── Two-Phase Data Loading ─────────────────────────────────────────────────
//
// Phase 1 (Primary):  Files with a `LangID` column (Ethnologue convention).
//                     Provides ISO code + English name. Creates entries.
//
// Phase 2 (Enrich):   Files with an `ISO_639` column (SIL autonyms convention).
//                     Provides localized names only. Never creates entries.
//
// This two-phase design eliminates file-ordering ambiguity entirely:
// primary files always run first, enrichment files only fill in nulls.
// ─────────────────────────────────────────────────────────────────────────────

interface LanguageRecord {
  langName: string;
  langNameLocalized: string | null;
  scriptDirection: 'ltr' | 'rtl';
}

/**
 * Phase 1: Build the base language list from primary data files.
 * A primary file is identified by having a `LangID` + `Name` column pair.
 */
function loadPrimaryLanguages(files: string[], folderPath: string): Map<string, LanguageRecord> {
  const map = new Map<string, LanguageRecord>();

  for (const file of files) {
    const { headers, rows } = readCsvFile(resolve(folderPath, file));
    const isoIdx = headers.indexOf('langid');
    const nameIdx = headers.indexOf('name');

    if (isoIdx === -1) continue; // not a primary file
    if (nameIdx === -1) {
      console.warn(`  ⚠ ${file}: has LangID column but no Name column. Skipping.`);
      continue;
    }

    let added = 0;
    for (const parts of rows) {
      const code = parts[isoIdx]?.trim();
      const name = parts[nameIdx]?.trim();
      if (!code || !name) continue;
      if (code.length !== 3) continue; // ISO 639-3 codes are exactly 3 chars
      if (map.has(code)) continue; // first occurrence wins

      map.set(code, {
        langName: truncate(name, MAX_FIELD_LENGTH),
        langNameLocalized: null,
        scriptDirection: isRTL(code, name) ? 'rtl' : 'ltr',
      });
      added++;
    }

    console.log(`  ✓ ${file}: ${added} languages loaded`);
  }

  return map;
}

/**
 * Phase 2: Enrich existing entries with supplementary data.
 * An enrichment file is identified by having an `ISO_639` + `Print_Name` column pair.
 * Only fills in null fields — never overwrites and never creates new entries.
 */
function enrichWithSupplementary(
  map: Map<string, LanguageRecord>,
  files: string[],
  folderPath: string
): number {
  let totalEnriched = 0;

  for (const file of files) {
    const { headers, rows } = readCsvFile(resolve(folderPath, file));
    const isoIdx = headers.indexOf('iso_639');
    const printNameIdx = headers.indexOf('print_name');

    if (isoIdx === -1 || printNameIdx === -1) continue; // not an enrichment file

    let enriched = 0;
    for (const parts of rows) {
      const code = parts[isoIdx]?.trim();
      const printName = parts[printNameIdx]?.trim();
      if (!code || !printName) continue;

      const entry = map.get(code);
      // Only enrich entries that exist and don't already have a localized name
      if (entry && !entry.langNameLocalized) {
        entry.langNameLocalized = truncate(printName, MAX_FIELD_LENGTH);
        enriched++;
      }
    }

    totalEnriched += enriched;
    console.log(`  ✓ ${file}: ${enriched} languages enriched with localized names`);
  }

  return totalEnriched;
}

// ─── Seed Entry Point ────────────────────────────────────────────────────────

/**
 * Reads all CSV/TSV files from the language-data folder, merges them by
 * ISO 639-3 code in two phases (primary → enrich), and inserts any new
 * languages into the database inside a single transaction.
 */
export async function seedLanguages() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const dataFolder = resolve(__dirname, DATA_FOLDER);

  // Discover data files
  let files: string[];
  try {
    files = readdirSync(dataFolder).filter((f) =>
      ['.csv', '.tsv'].includes(extname(f).toLowerCase())
    );
  } catch (err) {
    throw new Error(`Language data folder not found: ${dataFolder}`, { cause: err });
  }

  if (files.length === 0) {
    throw new Error(`No CSV/TSV files found in ${dataFolder}`);
  }

  console.log(`Found ${files.length} data file(s)\n`);

  // Phase 1 — Build base language list
  console.log('Phase 1: Loading primary language data...');
  const allLanguages = loadPrimaryLanguages(files, dataFolder);

  if (allLanguages.size === 0) {
    throw new Error(
      'No primary language file found. Need at least one file with LangID + Name columns.'
    );
  }

  // Phase 2 — Enrich with localized names
  console.log('\nPhase 2: Enriching with localized names...');
  enrichWithSupplementary(allLanguages, files, dataFolder);

  // Phase 3 — Diff against DB and insert new entries
  console.log('\nPhase 3: Syncing to database...');
  const existing = await db.select({ code: languages.langCodeIso6393 }).from(languages);
  const existingCodes = new Set(existing.map((r) => r.code));

  const toInsert: {
    langCodeIso6393: string;
    langName: string;
    langNameLocalized: string | null;
    scriptDirection: 'ltr' | 'rtl';
  }[] = [];
  let rtlCount = 0;

  let skippedCount = 0;

  for (const [code, data] of allLanguages.entries()) {
    if (existingCodes.has(code)) {
      skippedCount++;
      continue;
    }

    if (data.scriptDirection === 'rtl') rtlCount++;

    toInsert.push({
      langCodeIso6393: code,
      langName: data.langName,
      langNameLocalized: data.langNameLocalized,
      scriptDirection: data.scriptDirection,
    });
  }

  if (toInsert.length === 0) {
    console.log('Database is already up to date. No new languages to insert.');
    return;
  }

  // Insert all chunks inside a single transaction (all-or-nothing)
  await db.transaction(async (tx) => {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      await tx.insert(languages).values(chunk);
      console.log(
        `  Chunk ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(toInsert.length / CHUNK_SIZE)} inserted`
      );
    }
  });

  // Summary
  const localizedCount = toInsert.filter((r) => r.langNameLocalized).length;
  console.log('\n═══ Seed Summary ═══');
  console.log(`  Total inserted:   ${toInsert.length}`);
  console.log(`  Skipped (in DB):  ${skippedCount}`);
  console.log(`  With autonym:     ${localizedCount}`);
  console.log(`  Without autonym:  ${toInsert.length - localizedCount}`);
  console.log(`  RTL:              ${rtlCount}`);
  console.log(`  LTR:              ${toInsert.length - rtlCount}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedLanguages()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
