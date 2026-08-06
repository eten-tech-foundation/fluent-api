/**
 * CLI: Enrich existing languages with localized names (autonyms).
 *
 * Usage:
 *   npm run db:import:language-names -- <path-to-autonyms-csv>
 *
 * The CSV/TSV must contain `ISO_639` and `Print_Name` columns. Only
 * languages that already exist in the DB and have no localized name
 * set will be updated. Never overwrites existing values.
 */
import { readFileSync } from 'node:fs';

import { enrichLocalizedNames } from '@/domains/languages/import/enrich-localized-names';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npm run db:import:language-names -- <path-to-autonyms-csv>');
    process.exit(1);
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read file: ${filePath}`, error);
    process.exit(1);
  }

  const summary = await enrichLocalizedNames(content);

  console.log('Localized-name enrichment complete:');
  console.log(`  Total rows:          ${summary.totalRows}`);
  console.log(`  Enriched:            ${summary.enriched}`);
  console.log(`  Skipped (no match):  ${summary.skippedNoMatch}`);
  console.log(`  Skipped (already set): ${summary.skippedAlreadySet}`);
  console.log(`  Skipped (invalid):   ${summary.skippedInvalid}`);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('Enrichment failed:', error);
    process.exit(1);
  });
