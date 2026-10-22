/**
 * Truthful current-stage entry time from `chapter_assignment_status_history`.
 *
 * Rule:
 * 1. Order rows by `createdAt ASC NULLS LAST`, then `id ASC` (serial tie-break).
 * 2. If history is empty, or the latest row's `status` ≠ the assignment's current
 *    status, return null (unproven / mismatched trail).
 * 3. Otherwise take the start of the trailing contiguous run of rows whose
 *    status equals the current status (re-entry → latest run; repeated
 *    same-status rows → first row of that trailing run).
 * 4. If that entry row's `createdAt` is null, return null.
 * 5. Never fall back to assignment createdAt / updatedAt / submittedTime / activity.
 */

export interface StatusHistoryRow {
  id: number;
  status: string;
  createdAt: Date | null;
}

function compareHistoryAsc(a: StatusHistoryRow, b: StatusHistoryRow): number {
  if (a.createdAt === null && b.createdAt === null) return a.id - b.id;
  if (a.createdAt === null) return 1;
  if (b.createdAt === null) return -1;
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id - b.id;
}

export function resolveStageEnteredAt(
  currentStatus: string,
  history: StatusHistoryRow[]
): string | null {
  if (history.length === 0) return null;

  const sorted = [...history].sort(compareHistoryAsc);
  const latest = sorted[sorted.length - 1]!;
  if (latest.status !== currentStatus) return null;

  let entry = latest;
  for (let i = sorted.length - 2; i >= 0; i--) {
    const row = sorted[i]!;
    if (row.status !== currentStatus) break;
    entry = row;
  }

  return entry.createdAt ? entry.createdAt.toISOString() : null;
}
