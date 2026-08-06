import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/db';
import { languages } from '@/db/schema';

import { parseCsv } from './csv';
import { normalizeIso6393Code } from './iso';

const MAX_FIELD_LENGTH = 255;

export interface EnrichSummary {
  totalRows: number;
  enriched: number;
  skippedNoMatch: number;
  skippedAlreadySet: number;
  skippedInvalid: number;
}

interface ExistingLanguage {
  id: number;
  code: string | null;
  localized: string | null;
}

export async function enrichLocalizedNames(csvContent: string): Promise<EnrichSummary> {
  const { headers, rows } = parseCsv(csvContent);

  const codeIdx = headers.indexOf('iso_639');
  const nameIdx = headers.indexOf('print_name');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error('CSV is missing required "ISO_639" and/or "Print_Name" columns');
  }

  const existing: ExistingLanguage[] = await db
    .select({
      id: languages.id,
      code: languages.langCodeIso6393,
      localized: languages.langNameLocalized,
    })
    .from(languages);

  const byCode = new Map(
    existing
      .filter((language) => language.code !== null)
      .map((language) => [(language.code as string).toLowerCase(), language])
  );

  let skippedNoMatch = 0;
  let skippedAlreadySet = 0;
  let skippedInvalid = 0;
  let enriched = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      const code = normalizeIso6393Code(row[codeIdx]);
      const printName = row[nameIdx]?.trim();

      if (!code || !printName) {
        skippedInvalid++;
        continue;
      }

      if (printName.length > MAX_FIELD_LENGTH) {
        throw new Error(
          `Localized name exceeds ${MAX_FIELD_LENGTH} characters for code "${code}": "${printName}"`
        );
      }

      const match = byCode.get(code);

      if (!match) {
        skippedNoMatch++;
        continue;
      }

      if (match.localized !== null) {
        skippedAlreadySet++;
        continue;
      }

      const result = await tx
        .update(languages)
        .set({ langNameLocalized: printName })
        .where(and(eq(languages.id, match.id), isNull(languages.langNameLocalized)))
        .returning({ id: languages.id });

      if (result.length > 0) {
        match.localized = printName;
        enriched++;
      } else {
        skippedAlreadySet++;
      }
    }
  });

  return {
    totalRows: rows.length,
    enriched,
    skippedNoMatch,
    skippedAlreadySet,
    skippedInvalid,
  };
}
