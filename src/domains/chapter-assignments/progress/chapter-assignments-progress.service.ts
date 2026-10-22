import type { DbTransaction, Result } from '@/lib/types';

import type { ChapterAssignmentProgressInfo } from '../chapter-assignments.types';
import type { ChapterAssignmentsProgressFilters } from './chapter-assignments-progress.types';

import * as progressRepo from './chapter-assignments-progress.repository';

export function getAssignmentsProgress(
  filters: ChapterAssignmentsProgressFilters,
  tx?: DbTransaction
): Promise<Result<ChapterAssignmentProgressInfo[]>> {
  return progressRepo.findAssignmentsProgress(filters, tx);
}
