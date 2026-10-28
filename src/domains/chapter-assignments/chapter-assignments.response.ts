import type { DbTransaction } from '@/lib/types';

import type {
  ChapterAssignmentRecord,
  ChapterAssignmentResponse,
} from './chapter-assignments.types';

import { getStageEnteredAtByAssignmentIds } from './chapter-assignments.stage-entered-at.lookup';

export function toChapterAssignmentResponse(
  record: ChapterAssignmentRecord,
  stageEnteredAt: string | null
): ChapterAssignmentResponse {
  return {
    id: record.id,
    projectUnitId: record.projectUnitId,
    bibleId: record.bibleId,
    bookId: record.bookId,
    chapterNumber: record.chapterNumber,
    assignedUserId: record.assignedUserId,
    peerCheckerId: record.peerCheckerId,
    status: record.status,
    submittedTime: record.submittedTime,
    hasClaimConflict: record.hasClaimConflict,
    claimConflictUserId: record.claimConflictUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    stageEnteredAt,
  };
}

export async function buildChapterAssignmentResponse(
  record: ChapterAssignmentRecord,
  tx?: DbTransaction
): Promise<ChapterAssignmentResponse> {
  const stageEnteredAtById = await getStageEnteredAtByAssignmentIds(
    [{ id: record.id, status: record.status }],
    tx
  );
  return toChapterAssignmentResponse(record, stageEnteredAtById.get(record.id) ?? null);
}

export async function buildChapterAssignmentResponses(
  records: ChapterAssignmentRecord[],
  tx?: DbTransaction
): Promise<ChapterAssignmentResponse[]> {
  const stageEnteredAtById = await getStageEnteredAtByAssignmentIds(
    records.map((record) => ({ id: record.id, status: record.status })),
    tx
  );
  return records.map((record) =>
    toChapterAssignmentResponse(record, stageEnteredAtById.get(record.id) ?? null)
  );
}
