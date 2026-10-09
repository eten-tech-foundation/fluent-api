import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';

import * as repository from './workflow-stages.repository';
import {
  addStage,
  deleteStage,
  reorderStages,
  WorkflowStageValidationError,
} from './workflow-stages.service';

const transaction = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        for: vi.fn().mockResolvedValue([{ id: 1 }]),
      })),
    })),
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

  it('rejects a new stage when the workflow already has ten stages in total', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages(10));

    await expect(addStage(1, 'Additional Review')).rejects.toThrow(
      'Maximum of 10 workflow stages reached.'
    );

    expect(repository.addWorkflowStage).not.toHaveBeenCalled();
  });

  it('rejects a duplicate stage name without writing', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages());

    await expect(addStage(1, 'stage 3')).rejects.toThrow(WorkflowStageValidationError);
    expect(repository.addWorkflowStage).not.toHaveBeenCalled();
  });

  it('does not delete a stage that has been reached by a chapter', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages());
    vi.mocked(repository.getLockedDefaultNames).mockResolvedValue(['not_started', 'stage_1']);

    await expect(deleteStage(1, 2)).rejects.toThrow('Cannot delete locked stage "Stage 1".');
  });

  it('requires a reorder request to contain every stage exactly once', async () => {
    vi.mocked(repository.getWorkflowStagesByProjectId).mockResolvedValue(makeStages());

    await expect(reorderStages(1, [1, 2, 2, 4, 5, 6, 7, 8])).rejects.toThrow(
      'Invalid stage list. All stages must be included exactly once.'
    );
  });
});
