import { getPericopeGroupNumber } from '@/domains/pericopes/pericopes.types';

/** Verse row shape for getPericopeGroupNumber matching. */
interface PericopeVerseIdentityRow {
  pericopeSetId: number;
  bookId: number;
  chapterNumber: number;
  section: number | null;
  pericopeNumber: string;
  pericopeTitle: string | null;
}

interface PublicPericopeMembership {
  pericopeSetId: number;
  bookId: number;
  chapterNumber: number;
  /** Public wire identity (e.g. FIA `1`, FCBH `6_1`) — not the raw DB column alone. */
  pericopeNumber: string;
  pericopeTitle: string | null;
}

/**
 * Resolve a client public pericope id against chapter-scoped verse rows.
 * Exact match on getPericopeGroupNumber only — no prefix stripping or lenient fallback.
 * Snapshots store this public wire id; 0038 pericope-verse mutation trigger matches the same.
 */
export function matchPublicPericopeMembership(
  rows: PericopeVerseIdentityRow[],
  publicPericopeNumber: string
): PublicPericopeMembership | null {
  const matches = rows.filter((row) => getPericopeGroupNumber(row) === publicPericopeNumber);
  if (matches.length === 0) return null;

  const row = matches.find((m) => m.pericopeTitle != null) ?? matches[0]!;
  return {
    pericopeSetId: row.pericopeSetId,
    bookId: row.bookId,
    chapterNumber: row.chapterNumber,
    pericopeNumber: publicPericopeNumber,
    pericopeTitle: row.pericopeTitle,
  };
}
