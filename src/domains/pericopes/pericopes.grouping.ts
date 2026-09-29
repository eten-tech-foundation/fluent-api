import type { PericopeGroup, PericopeVerseRow } from './pericopes.types';

// Rows must belong to one book and be ordered by chapter and verse.
export function groupPericopeVerses(rows: PericopeVerseRow[]): PericopeGroup[] {
  const groups = new Map<string, PericopeGroup>();
  for (const row of rows) {
    const key = row.section !== null ? `${row.section}_${row.pericopeNumber}` : row.pericopeNumber;
    if (!groups.has(key)) {
      groups.set(key, {
        pericopeNumber: key,
        pericopeTitle: row.pericopeTitle ?? null,
        verses: [],
      });
    }
    groups.get(key)!.verses.push({
      chapterNumber: row.chapterNumber,
      verseNumber: row.verseNumber,
    });
  }
  return Array.from(groups.values());
}
