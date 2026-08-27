import type { DblClient } from '@/lib/services/dbl/dbl.client';
import type { DblBibleSummary } from '@/lib/services/dbl/dbl.types';
import type { Result } from '@/lib/types';

import { logger } from '@/lib/logger';
import { dblClient } from '@/lib/services/dbl/dbl.client';

import type { DblLanguageUpsertInput } from '../languages.repository';

import { normalizeIso6393Code } from '../import/iso';
import { upsertFromDbl } from '../languages.repository';

const MAX_FIELD_LENGTH = 255;

export interface DblLanguageSyncSummary {
  totalBibles: number;
  uniqueLanguages: number;
  skippedInvalid: number;
  inserted: number;
  updated: number;
}

/**
 * DBL/API.Bible has no standalone "list languages" endpoint — the language
 * set is derived from GET /bibles, which embeds a `language` object on every
 * Bible (see https://docs.api.bible/guides/bibles). This dedupes that by
 * ISO 639-3 code and reconciles the result against `languages`.
 *
 * For existing languages, only NULL fields are filled in from DBL (via
 * COALESCE in the repository layer) — data already present in the database
 * is never overwritten. New language codes are inserted as full rows.
 *
 * Accepts a DblClient for injection in tests; defaults to the app-wide
 * singleton so callers (the worker) don't need to wire it themselves.
 */
export async function syncLanguagesFromDbl(
  client: DblClient = dblClient
): Promise<Result<DblLanguageSyncSummary>> {
  const biblesResult = await client.getBibles();
  if (!biblesResult.ok) return biblesResult;

  const bibles = biblesResult.data;
  const { rows, skippedInvalid } = dedupeLanguages(bibles);

  const upsertResult = await upsertFromDbl(rows);
  if (!upsertResult.ok) return upsertResult;

  return {
    ok: true,
    data: {
      totalBibles: bibles.length,
      uniqueLanguages: rows.length,
      skippedInvalid,
      inserted: upsertResult.data.inserted,
      updated: upsertResult.data.updated,
    },
  };
}

function dedupeLanguages(bibles: DblBibleSummary[]): {
  rows: DblLanguageUpsertInput[];
  skippedInvalid: number;
} {
  const byCode = new Map<string, DblLanguageUpsertInput>();
  let skippedInvalid = 0;

  for (const bible of bibles) {
    const { language } = bible;
    const code = normalizeIso6393Code(language.id);

    if (!code) {
      logger.warn('Skipping DBL language with an unrecognized code', {
        rawCode: language.id,
        bibleId: bible.id,
      });
      skippedInvalid++;
      continue;
    }

    if (
      language.name.length > MAX_FIELD_LENGTH ||
      (language.nameLocal?.length ?? 0) > MAX_FIELD_LENGTH
    ) {
      logger.warn('Skipping DBL language with an over-length name', { code });
      skippedInvalid++;
      continue;
    }

    // First Bible wins per code; every Bible in the same language should
    // report the same language metadata, so later duplicates are redundant.
    if (byCode.has(code)) continue;

    byCode.set(code, {
      langCodeIso6393: code,
      langName: language.name,
      langNameLocalized: language.nameLocal || null,
      scriptDirection: language.scriptDirection?.toUpperCase() === 'RTL' ? 'rtl' : 'ltr',
    });
  }

  return { rows: [...byCode.values()], skippedInvalid };
}
