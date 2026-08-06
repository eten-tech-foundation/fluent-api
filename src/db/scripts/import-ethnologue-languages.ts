/**
 * CLI: Import Ethnologue language codes into the `languages` table.
 *
 * Usage:
 *   npm run db:import:languages -- <path-to-ethnologue-csv>
 *
 * The CSV/TSV must contain `LangID` and `Name` columns (delimiter is
 * auto-detected). Source files are NOT committed to the repo — each
 * operator supplies their own file path at invocation time.
 *
 * Re-running with the same file is safe (insert-only, idempotent).
 */
import { readFileSync } from 'node:fs';

import { importEthnologueLanguages } from '@/domains/languages/import/import-ethnologue';

async function main() {
  const filePath = process.argv[2];

  if (!filePath) {
    console.error('Usage: npm run db:import:languages -- <path-to-ethnologue-csv>');
    process.exitCode = 1;
    return;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read file: ${filePath}`, error);
    process.exitCode = 1;
    return;
  }

  const summary = await importEthnologueLanguages(content);

  console.log('Ethnologue import complete:');
  console.log(`  Total rows:        ${summary.totalRows}`);
  console.log(`  Inserted:          ${summary.inserted}`);
  console.log(`  Skipped (in DB):   ${summary.skippedExisting}`);
  console.log(`  Skipped (invalid): ${summary.skippedInvalid}`);
  console.log(`  RTL:               ${summary.rtlCount}`);
  console.log(`  LTR:               ${summary.ltrCount}`);
}

main().catch((error: unknown) => {
  console.error('Import failed:', error);
  process.exitCode = 1;
});
