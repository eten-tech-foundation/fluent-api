import type { DbTransaction, Result } from '@/lib/types';

import type { ChapterAssignmentProgressInfo } from '../chapter-assignments.types';
import type { ChapterAssignmentsProgressFilters } from './chapter-assignments-progress.types';

import { getStageEnteredAtByAssignmentIds } from '../chapter-assignments.stage-entered-at.lookup';
import * as progressRepo from './chapter-assignments-progress.repository';

export async function getAssignmentsProgress(
  filters: ChapterAssignmentsProgressFilters,
  tx?: DbTransaction
): Promise<Result<ChapterAssignmentProgressInfo[]>> {
  const result = await progressRepo.findAssignmentsProgress(filters, tx);
  if (!result.ok) return result;

  const stageEnteredAtById = await getStageEnteredAtByAssignmentIds(
    result.data.map((row) => ({ id: row.assignmentId, status: row.status })),
    tx
  );

  return {
    ok: true,
    data: result.data.map((row) => ({
      ...row,
      stageEnteredAt: stageEnteredAtById.get(row.assignmentId) ?? null,
    })),
  };
}
