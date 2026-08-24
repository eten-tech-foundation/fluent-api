import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorCode } from '@/lib/types';

import type { ChapterAssignmentRecord } from './chapter-assignments.types';

import * as repo from './chapter-assignments.repository';
import {
  claimChapterAssignment,
  toChapterAssignmentResponse,
  updateChapterAssignment,
} from './chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

const mockTx = { _isMockTx: true } as any;

vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

vi.mock('./chapter-assignments.repository', () => ({
  findById: vi.fn(),
  claimIfUnassigned: vi.fn(),
  flagClaimConflict: vi.fn(),
  insertStatusHistory: vi.fn(),
  insertUserAssignmentHistory: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  touchProjectActivity: vi.fn(),
}));

vi.mock('@/domains/ai-suggestions/ai-suggestions.service', () => ({
  handleChapterAssigned: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const baseRecord: ChapterAssignmentRecord = {
  id: 1,
  projectUnitId: 10,
  bibleId: 1,
  bookId: 1,
  chapterNumber: 1,
  assignedUserId: null as number | null,
  peerCheckerId: null,
  status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
  submittedTime: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
};

describe('claimChapterAssignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx));
  });

  it('claims an unassigned chapter, records history, and returns draft without conflict', async () => {
    const claimedRecord = {
      ...baseRecord,
      assignedUserId: 5,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
    };
    vi.mocked(repo.claimIfUnassigned).mockResolvedValue({ claimed: true, record: claimedRecord });

    const result = await claimChapterAssignment(1, 5);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assignedUserId).toBe(5);
      expect(result.data.status).toBe(CHAPTER_ASSIGNMENT_STATUS.DRAFT);
      expect(result.data.hasClaimConflict).toBe(false);
    }
    expect(repo.insertStatusHistory).toHaveBeenCalledWith(
      mockTx,
      1,
      CHAPTER_ASSIGNMENT_STATUS.DRAFT
    );
    expect(repo.insertUserAssignmentHistory).toHaveBeenCalledWith(
      mockTx,
      1,
      5,
      'drafter',
      CHAPTER_ASSIGNMENT_STATUS.DRAFT
    );
    expect(repo.flagClaimConflict).not.toHaveBeenCalled();
  });

  it('is idempotent when the same user claims again', async () => {
    const ownedRecord = {
      ...baseRecord,
      assignedUserId: 5,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
    };
    vi.mocked(repo.claimIfUnassigned).mockResolvedValue({ claimed: false, record: null });
    vi.mocked(repo.findById).mockResolvedValue(ownedRecord);

    const result = await claimChapterAssignment(1, 5);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.assignedUserId).toBe(5);
      expect(result.data.hasClaimConflict).toBe(false);
    }
    expect(repo.insertStatusHistory).not.toHaveBeenCalled();
    expect(repo.insertUserAssignmentHistory).not.toHaveBeenCalled();
    expect(repo.flagClaimConflict).not.toHaveBeenCalled();
  });

  it('flags conflict instead of error when another user already claimed', async () => {
    const winnerRecord = {
      ...baseRecord,
      assignedUserId: 7,
      status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
    };
    const conflictRecord = { ...winnerRecord, hasClaimConflict: true };

    vi.mocked(repo.claimIfUnassigned).mockResolvedValue({ claimed: false, record: null });
    vi.mocked(repo.findById).mockResolvedValue(winnerRecord);
    vi.mocked(repo.flagClaimConflict).mockResolvedValue(conflictRecord);

    const result = await claimChapterAssignment(1, 5);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.hasClaimConflict).toBe(true);
      expect(result.data.assignedUserId).toBe(7);
    }
    expect(repo.flagClaimConflict).toHaveBeenCalledWith(1, mockTx);
  });

  it('returns not found when the assignment does not exist after losing the race', async () => {
    vi.mocked(repo.claimIfUnassigned).mockResolvedValue({ claimed: false, record: null });
    vi.mocked(repo.findById).mockResolvedValue(null);

    const result = await claimChapterAssignment(1, 5);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND);
    }
  });

  it('handles two overlapping claim transactions with one winner and one conflict', async () => {
    let row: ChapterAssignmentRecord = { ...baseRecord };

    vi.mocked(repo.claimIfUnassigned).mockImplementation(async (_id, userId) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (row.assignedUserId === null && row.status === CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED) {
        row = {
          ...row,
          assignedUserId: userId,
          status: CHAPTER_ASSIGNMENT_STATUS.DRAFT,
        };
        return { claimed: true, record: row };
      }
      return { claimed: false, record: null };
    });

    vi.mocked(repo.findById).mockImplementation(async () => ({ ...row }));
    vi.mocked(repo.flagClaimConflict).mockImplementation(async () => {
      row = { ...row, hasClaimConflict: true };
      return row;
    });
    vi.mocked(repo.insertStatusHistory).mockResolvedValue(undefined);
    vi.mocked(repo.insertUserAssignmentHistory).mockResolvedValue(undefined);

    const [resultA, resultB] = await Promise.all([
      claimChapterAssignment(1, 10),
      claimChapterAssignment(1, 20),
    ]);

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);

    const winners = [resultA, resultB].filter((r) => r.ok && r.data.hasClaimConflict !== true);
    const losers = [resultA, resultB].filter((r) => r.ok && r.data.hasClaimConflict === true);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(row.hasClaimConflict).toBe(true);
    expect([10, 20]).toContain(row.assignedUserId);
  });
});

describe('updateChapterAssignment conflict resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (cb) => cb(mockTx));
  });

  it('clears hasClaimConflict when a PM sets assignedUserId', async () => {
    const current = { ...baseRecord, assignedUserId: 7, hasClaimConflict: true };
    const updated = { ...current, assignedUserId: 9, hasClaimConflict: false };

    vi.mocked(repo.findById).mockResolvedValue(current);
    vi.mocked(repo.update).mockResolvedValue(updated);

    const result = await updateChapterAssignment(1, { assignedUserId: 9 });

    expect(result.ok).toBe(true);
    expect(repo.update).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ assignedUserId: 9, hasClaimConflict: false }),
      mockTx
    );
    if (result.ok) {
      expect(result.data.hasClaimConflict).toBe(false);
    }
  });
});

describe('toChapterAssignmentResponse', () => {
  it('includes hasClaimConflict in the response payload', () => {
    const response = toChapterAssignmentResponse({
      ...baseRecord,
      hasClaimConflict: true,
    });
    expect(response.hasClaimConflict).toBe(true);
  });
});
