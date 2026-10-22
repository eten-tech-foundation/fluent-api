/**
 * Truthful current-stage entry time from `chapter_assignment_status_history`.
 *
 * Rule:
 * 1. If history is empty, return null.
 * 2. If **any** history row has `createdAt: null`, return null (conservative
 *    unavailability — do not invent position via NULLS LAST or other guesses).
 * 3. Otherwise order by `createdAt ASC`, then `id ASC` (serial tie-break).
 * 4. If the latest row's `status` ≠ the assignment's current status, return null.
 * 5. Otherwise take the start of the trailing contiguous run of rows whose
 *    status equals the current status (re-entry → latest run; repeated
 *    same-status rows → first row of that trailing run; they do not reset entry).
 * 6. Never fall back to assignment createdAt / updatedAt / submittedTime / activity.
 */

export interface StatusHistoryRow {
  id: number;
  status: string;
  createdAt: Date | null;
}

function compareHistoryAsc(a: StatusHistoryRow, b: StatusHistoryRow): number {
  // Caller guarantees every createdAt is non-null.
  const byTime = a.createdAt!.getTime() - b.createdAt!.getTime();
  if (byTime !== 0) return byTime;
  return a.id - b.id;
}

export function resolveStageEnteredAt(
  currentStatus: string,
  history: StatusHistoryRow[]
): string | null {
  if (history.length === 0) return null;
  if (history.some((row) => row.createdAt === null)) return null;

  const sorted = [...history].sort(compareHistoryAsc);
  const latest = sorted[sorted.length - 1]!;
  if (latest.status !== currentStatus) return null;

  let entry = latest;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const row = sorted[i]!;
    if (row.status !== currentStatus) break;
    entry = row;
  }

  return entry.createdAt!.toISOString();
}
