import type { DbTransaction, Result } from '@/lib/types';

import type {
  ChapterAssignmentProgressInfo,
  ChapterAssignmentStatus,
} from './chapter-assignments.types';

import * as progressRepo from './chapter-assignments.progress.repository';

export function getAssignmentsProgress(
  filters: {
    projectId?: number;
    orgId?: number;
    assignedUserId?: number;
    peerCheckerId?: number;
    status?: ChapterAssignmentStatus;
  },
  tx?: DbTransaction
): Promise<Result<ChapterAssignmentProgressInfo[]>> {
  return progressRepo.findAssignmentsProgress(filters, tx);
}
