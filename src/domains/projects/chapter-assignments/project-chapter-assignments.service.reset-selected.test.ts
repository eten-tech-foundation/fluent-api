import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ChapterAssignmentProgressInfo,
  ChapterAssignmentRecord,
} from '@/domains/chapter-assignments/chapter-assignments.types';

import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_STATUS } from '@/domains/chapter-assignments/chapter-assignments.types';
import { lockProject } from '@/domains/projects/workflow-stages/workflow-stages.service';
import { ErrorCode, ok } from '@/lib/types';
import { sampleChapterAssignments } from '@/test/utils/test-helpers';

import * as projectRepo from '../projects.repository';
import * as repo from './project-chapter-assignments.repository';
import { resetSelectedChapters } from './project-chapter-assignments.service';

const tx = Symbol('tx');

vi.mock('@/db/transaction', () => ({
  runInTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock('../projects.repository', () => ({
  findAssignmentIdsNotInProject: vi.fn(),
}));

vi.mock('./project-chapter-assignments.repository', async () => {
  const actual = await vi.importActual<typeof import('./project-chapter-assignments.repository')>(
    './project-chapter-assignments.repository'
  );
  return {
    ...actual,
    findStatusesByIds: vi.fn(),
  };
});

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  updateChapterAssignment: vi.fn(),
  getAssignmentsProgress: vi.fn(),
  buildChapterAssignmentResponses: vi.fn(),
}));

vi.mock('@/domains/projects/workflow-stages/workflow-stages.service', () => ({
  lockProject: vi.fn(),
}));

const progressInfo: ChapterAssignmentProgressInfo = {
  assignmentId: 11,
  projectId: 5,
  projectName: 'Demo',
  projectUnitId: 21,
  status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
  bookNameEng: 'Matthew',
  chapterNumber: 1,
  bibleId: 3,
  bibleName: 'Demo Bible',
  ttsLicenseStatus: 'unknown',
  textBibleKey: null,
  selectedRecordingKey: null,
  bookId: 40,
  bookCode: 'MAT',
  targetLanguage: 'Spanish',
  sourceLangCode: 'eng',
  targetLangCode: 'spa',
  assignedUserId: null,
  assignedUserDisplayName: null,
  peerCheckerId: null,
  peerCheckerDisplayName: null,
  totalVerses: 25,
  completedVerses: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  submittedTime: null,
  stageEnteredAt: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  claimConflictUserId: null,
  hasConflict: false,
};

const updatedRecord: ChapterAssignmentRecord = {
  ...sampleChapterAssignments[0],
  id: 11,
  peerCheckerId: null,
  status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
  submittedTime: null,
  isAiEnabled: false,
  hasClaimConflict: false,
  claimConflictUserId: null,
};

const updatedResponse = { ...updatedRecord, stageEnteredAt: null };

describe('resetSelectedChapters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lockProject).mockResolvedValue(ok(undefined));
  });

  it('resets draft and peer_check chapters and returns progress rows', async () => {
    vi.mocked(projectRepo.findAssignmentIdsNotInProject).mockResolvedValue([]);
    vi.mocked(repo.findStatusesByIds).mockResolvedValue([
      { id: 11, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
      { id: 12, status: CHAPTER_ASSIGNMENT_STATUS.PEER_CHECK },
    ]);
    vi.mocked(chapterAssignmentService.updateChapterAssignment).mockResolvedValue(
      ok(updatedResponse)
    );
    vi.mocked(chapterAssignmentService.getAssignmentsProgress).mockResolvedValue(
      ok([progressInfo, { ...progressInfo, assignmentId: 12, chapterNumber: 2 }])
    );

    const result = await resetSelectedChapters(5, [11, 12]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(2);
    expect(lockProject).toHaveBeenCalledWith(tx, 5);
    expect(chapterAssignmentService.updateChapterAssignment).toHaveBeenCalledTimes(2);
    expect(chapterAssignmentService.updateChapterAssignment).toHaveBeenCalledWith(
      11,
      {
        status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
        assignedUserId: null,
        peerCheckerId: null,
        submittedTime: null,
      },
      tx
    );
    expect(chapterAssignmentService.updateChapterAssignment).toHaveBeenCalledWith(
      12,
      {
        status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED,
        assignedUserId: null,
        peerCheckerId: null,
        submittedTime: null,
      },
      tx
    );
  });

  it('returns NOT_FOUND when any id is outside the project', async () => {
    vi.mocked(projectRepo.findAssignmentIdsNotInProject).mockResolvedValue([99]);

    const result = await resetSelectedChapters(5, [11, 99]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(chapterAssignmentService.updateChapterAssignment).not.toHaveBeenCalled();
  });

  it('returns CHAPTER_ASSIGNMENT_NOT_RESETTABLE for complete status', async () => {
    vi.mocked(projectRepo.findAssignmentIdsNotInProject).mockResolvedValue([]);
    vi.mocked(repo.findStatusesByIds).mockResolvedValue([
      { id: 11, status: CHAPTER_ASSIGNMENT_STATUS.COMPLETE },
    ]);

    const result = await resetSelectedChapters(5, [11]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CHAPTER_ASSIGNMENT_NOT_RESETTABLE);
    expect(chapterAssignmentService.updateChapterAssignment).not.toHaveBeenCalled();
  });

  it('returns CHAPTER_ASSIGNMENT_NOT_RESETTABLE for not_started status', async () => {
    vi.mocked(projectRepo.findAssignmentIdsNotInProject).mockResolvedValue([]);
    vi.mocked(repo.findStatusesByIds).mockResolvedValue([
      { id: 11, status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED },
    ]);

    const result = await resetSelectedChapters(5, [11]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CHAPTER_ASSIGNMENT_NOT_RESETTABLE);
    expect(chapterAssignmentService.updateChapterAssignment).not.toHaveBeenCalled();
  });

  it('returns CHAPTER_LIMIT_EXCEEDED when the request is over the max', async () => {
    const ids = Array.from(
      { length: repo.MAX_CHAPTER_ASSIGNMENTS_PER_REQUEST + 1 },
      (_, i) => i + 1
    );

    const result = await resetSelectedChapters(5, ids);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(ErrorCode.CHAPTER_LIMIT_EXCEEDED);
    expect(lockProject).not.toHaveBeenCalled();
    expect(projectRepo.findAssignmentIdsNotInProject).not.toHaveBeenCalled();
  });

  it('calls updateChapterAssignment with the reset payload for each id', async () => {
    vi.mocked(projectRepo.findAssignmentIdsNotInProject).mockResolvedValue([]);
    vi.mocked(repo.findStatusesByIds).mockResolvedValue([
      { id: 11, status: CHAPTER_ASSIGNMENT_STATUS.DRAFT },
    ]);
    vi.mocked(chapterAssignmentService.updateChapterAssignment).mockResolvedValue(
      ok(updatedResponse)
    );
    vi.mocked(chapterAssignmentService.getAssignmentsProgress).mockResolvedValue(
      ok([progressInfo])
    );

    await resetSelectedChapters(5, [11]);

    expect(chapterAssignmentService.updateChapterAssignment).toHaveBeenCalledWith(
      11,
      expect.objectContaining({ status: CHAPTER_ASSIGNMENT_STATUS.NOT_STARTED }),
      tx
    );
  });
});
