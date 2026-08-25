import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { Result } from '@/lib/types';

import { normalizeIso6393Code } from '@/domains/languages/import/iso';
import * as languagesRepository from '@/domains/languages/languages.repository';
import { dblClient } from '@/lib/services/dbl/dbl.client';

import type { DblBibleUpsertInput } from '../bibles.repository';

import * as biblesRepository from '../bibles.repository';

export interface DblBibleSyncSummary {
  totalBibles: number;
  skippedMissingLanguage: number;
  inserted: number;
  updated: number;
}

/**
 * Fetches all open-license Bibles from DBL and upserts them into `bibles`.
 * Bibles without a corresponding valid language in the DB are skipped.
 *
 * Note: `syncLanguagesFromDbl` should generally be called BEFORE this
 * to ensure the languages table is fully populated.
 */
export async function syncBiblesFromDbl(
  client: DblClient = dblClient
): Promise<Result<DblBibleSyncSummary>> {
  const biblesResult = await client.getBibles();
  if (!biblesResult.ok) return biblesResult;
  const allBibles = biblesResult.data;

  const languagesResult = await languagesRepository.getAll();
  if (!languagesResult.ok) return languagesResult;

  const langCodeToId = new Map<string, number>();
  for (const lang of languagesResult.data) {
    if (lang.langCodeIso6393) {
      langCodeToId.set(lang.langCodeIso6393, lang.id);
    }
  }

  const rows: DblBibleUpsertInput[] = [];
  const seenAbbreviations = new Set<string>();
  const seenNames = new Set<string>();
  let skippedMissingLanguage = 0;

  // Pre-populate with existing DB bibles to prevent collisions with seed/existing data
  const existingResult = await biblesRepository.getAll();
  if (existingResult.ok) {
    for (const b of existingResult.data) {
      if (b.abbreviation) seenAbbreviations.add(b.abbreviation.toLowerCase());
      if (b.name) seenNames.add(b.name.toLowerCase());
    }
  }

  for (const bible of allBibles) {
    if (!bible.language) {
      skippedMissingLanguage++;
      continue;
    }

    const code = normalizeIso6393Code(bible.language.id);
    if (!code) {
      skippedMissingLanguage++;
      continue;
    }

    const languageId = langCodeToId.get(code);
    if (!languageId) {
      skippedMissingLanguage++;
      continue;
    }

    const baseAbbrev = (bible.abbreviationLocal || bible.abbreviation || 'BIBLE').trim();
    let abbrev = baseAbbrev;
    let counter = 1;

    while (seenAbbreviations.has(abbrev.toLowerCase())) {
      abbrev = `${baseAbbrev}-${bible.id.slice(0, 6)}${counter > 1 ? `-${counter}` : ''}`;
      counter++;
    }
    seenAbbreviations.add(abbrev.toLowerCase());

    const baseName = (bible.name || bible.nameLocal || abbrev).trim();
    let name = baseName;
    counter = 1;

    while (seenNames.has(name.toLowerCase())) {
      name = `${baseName} (${abbrev})`;
      if (seenNames.has(name.toLowerCase())) {
        name = `${baseName} (${abbrev}-${counter})`;
        counter++;
      }
    }
    seenNames.add(name.toLowerCase());

    rows.push({
      languageId,
      name,
      abbreviation: abbrev,
      provider: 'dbl',
      externalId: bible.id,
    });
  }

  const upsertResult = await biblesRepository.upsertFromDbl(rows);
  if (!upsertResult.ok) return upsertResult;

  return {
    ok: true,
    data: {
      totalBibles: allBibles.length,
      skippedMissingLanguage,
      inserted: upsertResult.data.inserted,
      updated: upsertResult.data.updated,
    },
  };
}
