import type { DbTransaction } from '@/lib/types';

import * as repo from './chapter-assignments.repository';
import { resolveStageEnteredAt } from './chapter-assignments.stage-entered-at';

/**
 * Batch-resolve `stageEnteredAt` for many assignments (one history query).
 */
export async function getStageEnteredAtByAssignmentIds(
  items: { id: number; status: string }[],
  tx?: DbTransaction
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>();
  if (items.length === 0) return map;

  const historyById = await repo.findStatusHistoryByAssignmentIds(
    items.map((item) => item.id),
    tx
  );

  for (const item of items) {
    map.set(item.id, resolveStageEnteredAt(item.status, historyById.get(item.id) ?? []));
  }
  return map;
}
