import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorCode } from '@/lib/types';

import * as repository from './workflow-stages.repository';
import {
  addStage,
  deleteStage,
  renameStage,
  reorderStages,
} from './workflow-stages.service';

const transaction = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: vi.fn().mockResolvedValue([{ id: 1 }]),
      })),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockResolvedValue([]),
    })),
  })),
  delete: vi.fn(() => ({
    where: vi.fn().mockResolvedValue([]),
  })),
};

vi.mock('@/db', () => ({
  db: {
    transaction: vi.fn(),
  },
}));

vi.mock('./workflow-stages.repository', () => ({
  getWorkflowStagesByProjectId: vi.fn(),
  addWorkflowStage: vi.fn(),
  getLockedDefaultNames: vi.fn(),
  renameWorkflowStage: vi.fn(),
  deleteWorkflowStage: vi.fn(),
}));

const makeStages = (count = 8) =>
  Array.from({ length: count }, (_, position) => ({
    id: position + 1,
    projectId: 1,
    defaultName:
      position === 0 ? 'not_started' : position === count - 1 ? 'complete' : `stage_${position}`,
    displayName: `Stage ${position}`,
    position,
    isFixed: position === 0 || position === count - 1,
    createdAt: null,
    updatedAt: null,
  }));

describe('workflow stages service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.transaction).mockImplementation(async (callback) => callback(transaction as any));
  });

  it('rejects adding a stage when the workflow already has 10 configurable stages (12 total)', async () => {
    // 10 configurable stages + 2 bookends = 12 total rows
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(12));

    const result = await addStage(1, 'Additional Review');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LIMIT_REACHED);
    }
    expect(repository.addWorkflowStage).not.toHaveBeenCalled();
  });

  it('allows adding a stage when total count is 10 (8 configurable stages)', async () => {
    // Default 8 rows = 6 configurable + 2 bookends. 10 rows = 8 configurable + 2 bookends.
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(10));
    vi.mocked(repository.addWorkflowStage).mockResolvedValue({
      id: 99,
      projectId: 1,
      defaultName: 'custom_new',
      displayName: 'Additional Review',
      position: 9,
      isFixed: false,
      createdAt: null,
      updatedAt: null,
    });
    vi.mocked(repository.getLockedDefaultNames).mockResolvedValue([]);

    const result = await addStage(1, 'Additional Review');
    expect(result.ok).toBe(true);
    expect(repository.addWorkflowStage).toHaveBeenCalled();
  });

  it('rejects renaming a stage to a duplicate name', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(8));

    const result = await renameStage(1, 2, 'Stage 3');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME);
    }
    expect(repository.renameWorkflowStage).not.toHaveBeenCalled();
  });

  it('does not delete a stage that has been reached by a chapter', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(8));
    vi.mocked(repository.getLockedDefaultNames).mockResolvedValue(['not_started', 'stage_1']);

    const result = await deleteStage(1, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_LOCKED);
    }
  });

  it('requires a reorder request to contain every stage exactly once', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(8));

    const result = await reorderStages(1, [1, 2, 2, 4, 5, 6, 7, 8]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.WORKFLOW_STAGE_INVALID_LIST);
    }
  });
});
