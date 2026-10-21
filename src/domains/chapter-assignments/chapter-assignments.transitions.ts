import type { DbTransaction } from '@/lib/types';

import type {
  ChapterAssignmentRecord,
  ChapterAssignmentStatus,
  UpdateChapterAssignmentRequestData,
} from './chapter-assignments.types';

import * as repo from './chapter-assignments.repository';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

export function applyAutoTransition(
  current: ChapterAssignmentRecord,
  data: UpdateChapterAssignmentRequestData
): UpdateChapterAssignmentRequestData {
  const hasUserAssignment = data.assignedUserId !== undefined || data.peerCheckerId !== undefined;
  const shouldAutoTransitionToDraft =
    current.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED && hasUserAssignment && !data.status;

  return {
    ...data,
    ...(shouldAutoTransitionToDraft && { status: CHAPTER_ASSIGNMENT_STATUS.DRAFT }),
  };
}

export async function recordStatusChange(
  tx: DbTransaction,
  current: ChapterAssignmentRecord,
  updated: ChapterAssignmentRecord
) {
  if (updated.status !== current.status) {
    await repo.insertStatusHistory(tx, updated.id, updated.status as ChapterAssignmentStatus);
  }
}

export async function recordUserAssignmentChanges(
  tx: DbTransaction,
  current: ChapterAssignmentRecord,
  updated: ChapterAssignmentRecord,
  data: UpdateChapterAssignmentRequestData
): Promise<boolean> {
  let shouldTriggerAi = false;

  if (
    data.assignedUserId !== undefined &&
    data.assignedUserId !== current.assignedUserId &&
    updated.assignedUserId
  ) {
    await repo.insertUserAssignmentHistory(
      tx,
      updated.id,
      updated.assignedUserId,
      'drafter',
      updated.status as ChapterAssignmentStatus
    );
    shouldTriggerAi = true;
  }

  if (
    data.peerCheckerId !== undefined &&
    data.peerCheckerId !== current.peerCheckerId &&
    updated.peerCheckerId
  ) {
    await repo.insertUserAssignmentHistory(
      tx,
      updated.id,
      updated.peerCheckerId,
      'peer_checker',
      updated.status as ChapterAssignmentStatus
    );
  }

  return shouldTriggerAi;
}
