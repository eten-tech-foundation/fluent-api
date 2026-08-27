import { eq, sql } from 'drizzle-orm';

import type { Result } from '@/lib/types';

import { db } from '@/db';
import { languages } from '@/db/schema';
import { logger } from '@/lib/logger';
import { err, ErrorCode, ok } from '@/lib/types';

import type { Language } from './languages.types';

export async function getAll(): Promise<Result<Language[]>> {
  try {
    return ok(await db.select().from(languages));
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find all languages' });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

export async function getById(id: number): Promise<Result<Language>> {
  try {
    const [language] = await db.select().from(languages).where(eq(languages.id, id)).limit(1);

    if (!language) return err(ErrorCode.LANGUAGE_NOT_FOUND);
    return ok(language);
  } catch (error) {
    logger.error({ cause: error, message: 'Failed to find language by ID', context: { id } });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}

// ─── DBL sync ──────────────────────────────────────────────────────────────

const UPSERT_CHUNK_SIZE = 1000;

export interface DblLanguageUpsertInput {
  langCodeIso6393: string;
  langName: string;
  langNameLocalized: string | null;
  scriptDirection: 'ltr' | 'rtl';
}

export interface DblLanguageUpsertSummary {
  inserted: number;
  /**
   * Rows that already existed for that code and were written again. This
   * counts every conflict-path row, whether or not any field's value
   * actually differed — Postgres's `INSERT ... ON CONFLICT DO UPDATE` doesn't
   * expose the pre-update values, so "updated but identical" and "updated
   * with a real change" aren't distinguished here.
   */
  updated: number;
}

/**
 * Upserts languages keyed on `langCodeIso6393` (matches the DB's unique
 * constraint on that column): new codes are inserted as full rows; existing
 * codes only have NULL fields filled in from DBL via COALESCE — core data that
 * is already present in the database is never overwritten (though updatedAt is
 * touched on conflict).
 * Rows with no `langCodeIso6393` are never touched by this path.
 */
export async function upsertFromDbl(
  rows: DblLanguageUpsertInput[]
): Promise<Result<DblLanguageUpsertSummary>> {
  if (rows.length === 0) return ok({ inserted: 0, updated: 0 });

  try {
    let inserted = 0;
    let updated = 0;

    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
        const written = await tx
          .insert(languages)
          .values(chunk)
          .onConflictDoUpdate({
            target: languages.langCodeIso6393,
            set: {
              langName: sql`COALESCE(languages.lang_name, excluded.lang_name)`,
              langNameLocalized: sql`COALESCE(languages.lang_name_localized, excluded.lang_name_localized)`,
              scriptDirection: sql`COALESCE(languages.script_direction, excluded.script_direction)`,
              updatedAt: sql`now()`,
            },
          })
          // xmax = 0 is unset on a freshly inserted row and set to the current
          // transaction's ID on a row touched by the UPDATE arm of the
          // upsert — the standard Postgres trick for telling insert vs.
          // update apart from a single RETURNING clause.
          .returning({ wasInsert: sql<boolean>`(xmax = 0)` });

        for (const row of written) {
          if (row.wasInsert) inserted++;
          else updated++;
        }
      }
    });

    return ok({ inserted, updated });
  } catch (error) {
    logger.error({
      cause: error,
      message: 'Failed to upsert languages from DBL',
      context: { rowCount: rows.length },
    });
    return err(ErrorCode.INTERNAL_ERROR);
  }
}
