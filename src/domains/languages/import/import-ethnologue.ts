import { db } from '@/db';
import { languages } from '@/db/schema';

import { parseCsv } from './csv';
import { normalizeIso6393Code } from './iso';
import { isRTL } from './rtl';

const MAX_FIELD_LENGTH = 255;
const CHUNK_SIZE = 1000;

export interface ImportSummary {
  totalRows: number;
  inserted: number;
  skippedExisting: number;
  skippedInvalid: number;
  rtlCount: number;
  ltrCount: number;
}

interface PendingLanguage {
  langCodeIso6393: string;
  langName: string;
  scriptDirection: 'ltr' | 'rtl';
}

export async function importEthnologueLanguages(csvContent: string): Promise<ImportSummary> {
  const { headers, rows } = parseCsv(csvContent);

  const codeIdx = headers.indexOf('langid');
  const nameIdx = headers.indexOf('name');

  if (codeIdx === -1 || nameIdx === -1) {
    throw new Error('CSV is missing required "LangID" and/or "Name" columns');
  }

  const byCode = new Map<string, PendingLanguage>();
  let skippedInvalid = 0;

  for (const row of rows) {
    const code = normalizeIso6393Code(row[codeIdx]);
    const name = row[nameIdx]?.trim();

    if (!code || !name) {
      skippedInvalid++;
      continue;
    }

    if (name.length > MAX_FIELD_LENGTH) {
      throw new Error(
        `Language name exceeds ${MAX_FIELD_LENGTH} characters for code "${code}": "${name}"`
      );
    }

    if (byCode.has(code)) continue;

    byCode.set(code, {
      langCodeIso6393: code,
      langName: name,
      scriptDirection: isRTL(code, name) ? 'rtl' : 'ltr',
    });
  }

  const existing = await db.select({ code: languages.langCodeIso6393 }).from(languages);
  const existingCodes = new Set(existing.map((row) => row.code?.toLowerCase()));

  const toInsert: PendingLanguage[] = [];
  let skippedExisting = 0;

  for (const language of byCode.values()) {
    if (existingCodes.has(language.langCodeIso6393)) {
      skippedExisting++;
      continue;
    }
    toInsert.push(language);
  }

  let inserted = 0;
  let rtlCount = 0;
  let ltrCount = 0;

  await db.transaction(async (tx) => {
    for (let i = 0; i < toInsert.length; i += CHUNK_SIZE) {
      const chunk = toInsert.slice(i, i + CHUNK_SIZE);
      const insertedRows = await tx
        .insert(languages)
        .values(chunk)
        .onConflictDoNothing({ target: languages.langCodeIso6393 })
        .returning({ id: languages.id, scriptDirection: languages.scriptDirection });

      inserted += insertedRows.length;
      for (const row of insertedRows) {
        if (row.scriptDirection === 'rtl') rtlCount++;
        else ltrCount++;
      }
    }
  });

  return {
    totalRows: rows.length,
    inserted,
    skippedExisting,
    skippedInvalid,
    rtlCount,
    ltrCount,
  };
}
