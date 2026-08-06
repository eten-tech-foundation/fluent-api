import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { db } from '@/db';
import { languages } from '@/db/schema';

interface LanguageRecord {
  lang_name: string;
  lang_name_localized: string | null;
  lang_code_iso_639_3: string | null;
  script_direction: 'ltr' | 'rtl';
}

function loadLanguages(): LanguageRecord[] {
  const raw = readFileSync(new URL('./data/languages.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { languages: LanguageRecord[] }).languages;
}

export async function seedLanguages() {
  const records = loadLanguages();

  const existing = await db.select({ code: languages.langCodeIso6393 }).from(languages);
  const existingCodes = new Set(existing.map((r) => r.code));

  const toInsert = records
    .filter((r) => !existingCodes.has(r.lang_code_iso_639_3))
    .map((r) => ({
      langName: r.lang_name,
      langNameLocalized: r.lang_name_localized,
      langCodeIso6393: r.lang_code_iso_639_3,
      scriptDirection: r.script_direction,
    }));

  if (toInsert.length > 0) {
    await db.insert(languages).values(toInsert);
  }

  console.log(
    `Languages seeded. (${toInsert.length} new, ${records.length - toInsert.length} skipped)`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  seedLanguages()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
