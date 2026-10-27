import { describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '@/lib/types';

import type { ChapterAssignmentRecord } from './chapter-assignments.types';

import * as repo from './chapter-assignments.repository';
import {
  applyAutoTransition,
  recordStatusChange,
  recordUserAssignmentChanges,
} from './chapter-assignments.transitions';
import { CHAPTER_ASSIGNMENT_STATUS } from './chapter-assignments.types';

vi.mock('./chapter-assignments.repository', () => ({
  insertStatusHistory: vi.fn(async () => {}),
  insertUserAssignmentHistory: vi.fn(async () => {}),
}));

const mockRecord: ChapterAssignmentRecord = {
  id: 1,
  projectUnitId: 10,
  bibleId: 20,
  bookId: 30,
  chapterNumber: 1,
  assignedUserId: null,
  peerCheckerId: null,
  status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
  submittedTime: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  claimConflictUserId: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('chapter-assignments transitions', () => {
  describe('applyAutoTransition', () => {
    it('auto-transitions NOT_STARTED to DRAFT when assigning a user', () => {
      const result = applyAutoTransition(mockRecord, { assignedUserId: 5 });
      expect(result.status).toBe(CHAPTER_ASSIGNMENT_STATUS.DRAFT);
    });

    it('auto-transitions NOT_STARTED to DRAFT when unassigning a user (assignedUserId: null)', () => {
      const result = applyAutoTransition(mockRecord, { assignedUserId: null });
      expect(result.status).toBe(CHAPTER_ASSIGNMENT_STATUS.DRAFT);
    });

    it('auto-transitions NOT_STARTED to DRAFT when assigning a peer checker', () => {
      const result = applyAutoTransition(mockRecord, { peerCheckerId: 8 });
      expect(result.status).toBe(CHAPTER_ASSIGNMENT_STATUS.DRAFT);
    });

    it('does not auto-transition when neither user field is provided in update', () => {
      const result = applyAutoTransition(mockRecord, { isAiEnabled: true });
      expect(result.status).toBeUndefined();
    });

    it('preserves explicit status override if provided in input', () => {
      const result = applyAutoTransition(mockRecord, {
        assignedUserId: 5,
        status: CHAPTER_ASSIGNMENT_STATUS.COMPLETE,
      });
      expect(result.status).toBe(CHAPTER_ASSIGNMENT_STATUS.COMPLETE);
    });

    it('does not transition if assignment is already in DRAFT', () => {
      const current = { ...mockRecord, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT };
      const result = applyAutoTransition(current, { assignedUserId: 5 });
      expect(result.status).toBeUndefined();
    });
  });

  describe('recordStatusChange', () => {
    it('inserts status history when status changed', async () => {
      const tx = {} as DbTransaction;
      const updated = { ...mockRecord, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT };
      await recordStatusChange(tx, mockRecord, updated);
      expect(repo.insertStatusHistory).toHaveBeenCalledWith(
        tx,
        mockRecord.id,
        CHAPTER_ASSIGNMENT_STATUS.DRAFT
      );
    });

    it('does nothing when status unchanged', async () => {
      vi.clearAllMocks();
      const tx = {} as DbTransaction;
      await recordStatusChange(tx, mockRecord, mockRecord);
      expect(repo.insertStatusHistory).not.toHaveBeenCalled();
    });
  });

  describe('recordUserAssignmentChanges', () => {
    it('records drafter change and triggers AI when assignedUserId changed', async () => {
      const tx = {} as DbTransaction;
      const updated = { ...mockRecord, assignedUserId: 5 };
      const shouldTriggerAi = await recordUserAssignmentChanges(tx, mockRecord, updated, {
        assignedUserId: 5,
      });
      expect(repo.insertUserAssignmentHistory).toHaveBeenCalledWith(
        tx,
        updated.id,
        5,
        'drafter',
        updated.status
      );
      expect(shouldTriggerAi).toBe(true);
    });

    it('records peer checker change when peerCheckerId changed', async () => {
      const tx = {} as DbTransaction;
      const updated = { ...mockRecord, peerCheckerId: 9 };
      const shouldTriggerAi = await recordUserAssignmentChanges(tx, mockRecord, updated, {
        peerCheckerId: 9,
      });
      expect(repo.insertUserAssignmentHistory).toHaveBeenCalledWith(
        tx,
        updated.id,
        9,
        'peer_checker',
        updated.status
      );
      expect(shouldTriggerAi).toBe(false);
    });
  });
});
