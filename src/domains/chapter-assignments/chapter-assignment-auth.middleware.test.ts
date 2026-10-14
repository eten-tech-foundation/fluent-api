import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChapterAssignmentWithAuthContext } from '@/domains/chapter-assignments/chapter-assignments.repository';
import type { AppEnv } from '@/server/context.types';

import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import { CHAPTER_ASSIGNMENT_ACTIONS } from '@/domains/chapter-assignments/chapter-assignments.types';
import * as workflowStagesRepo from '@/domains/projects/workflow-stages/workflow-stages.repository';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';

import { requireChapterAssignmentAccess } from './chapter-assignment-auth.middleware';

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  getChapterAssignmentWithAuthContext: vi.fn(),
}));

vi.mock('@/domains/projects/workflow-stages/workflow-stages.repository', () => ({
  getWorkflowStagesByProjectId: vi.fn(),
}));

const ORG_ID = 1;
const PROJECT_ID = 10;
const CHAPTER_ASSIGNMENT_ID = 42;

function assignGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.CONTENT_ASSIGN]) };
}

function updateGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.CONTENT_UPDATE]) };
}

const MANAGER = { id: 1, grants: [assignGrant(ORG_ID, PROJECT_ID)] };
const TRANSLATOR = { id: 2, grants: [updateGrant(ORG_ID, PROJECT_ID)] };
const OUTSIDER_TRANSLATOR = { id: 3, grants: [updateGrant(ORG_ID, PROJECT_ID)] };

const defaultStages = [
  { defaultName: 'not_started' },
  { defaultName: 'draft' },
  { defaultName: 'peer_check' },
  { defaultName: 'custom_review_1' },
  { defaultName: 'complete' },
];

function buildAssignment(
  overrides: Partial<ChapterAssignmentWithAuthContext> = {}
): ChapterAssignmentWithAuthContext {
  return {
    id: CHAPTER_ASSIGNMENT_ID,
    projectId: PROJECT_ID,
    organizationId: ORG_ID,
    status: 'custom_review_1',
    assignedUserId: 2,
    peerCheckerId: null,
    isProjectMember: true,
    updatedAt: new Date(),
    ...overrides,
  } as unknown as ChapterAssignmentWithAuthContext;
}

function appFor(
  user: object,
  action: (typeof CHAPTER_ASSIGNMENT_ACTIONS)[keyof typeof CHAPTER_ASSIGNMENT_ACTIONS] = CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT,
  paramName?: string
) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  const path = paramName ? `/assignments/:${paramName}` : '/assignments/:chapterAssignmentId';

  app.post(
    path,
    paramName
      ? requireChapterAssignmentAccess(action, paramName)
      : requireChapterAssignmentAccess(action),
    (c) =>
      c.json({
        reached: true,
        assignmentId: c.get('chapterAssignment')?.id ?? null,
      })
  );

  return app;
}

describe('requireChapterAssignmentAccess middleware with dynamic workflow stages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workflowStagesRepo.getWorkflowStagesByProjectId).mockResolvedValue(
      defaultStages as never
    );
  });

  describe('sUBMIT action in custom stage', () => {
    it('allows manager to submit a chapter in a custom workflow stage', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ isProjectMember: true }))
      );

      const app = appFor(MANAGER, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reached: true, assignmentId: CHAPTER_ASSIGNMENT_ID });
      expect(workflowStagesRepo.getWorkflowStagesByProjectId).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('allows project member translator to submit a chapter in a custom workflow stage', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ isProjectMember: true }))
      );

      const app = appFor(TRANSLATOR, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reached: true, assignmentId: CHAPTER_ASSIGNMENT_ID });
    });

    it('denies outsider translator from submitting a chapter in a custom stage (404)', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ isProjectMember: false }))
      );

      const app = appFor(OUTSIDER_TRANSLATOR, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ message: 'Chapter assignment not found' });
    });

    it('denies submitting when assignment is in an unlisted custom stage (404)', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ status: 'unlisted_stage', isProjectMember: true }))
      );

      const app = appFor(MANAGER, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ message: 'Chapter assignment not found' });
    });

    it('denies submitting when workflow stages list is empty (404)', async () => {
      vi.mocked(workflowStagesRepo.getWorkflowStagesByProjectId).mockResolvedValue([]);
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ isProjectMember: true }))
      );

      const app = appFor(MANAGER, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ message: 'Chapter assignment not found' });
    });
  });

  describe('iS_PARTICIPANT action in custom stage', () => {
    it('allows project member in custom workflow stage', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ isProjectMember: true }))
      );

      const app = appFor(TRANSLATOR, CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ reached: true, assignmentId: CHAPTER_ASSIGNMENT_ID });
      expect(workflowStagesRepo.getWorkflowStagesByProjectId).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('denies user when custom stage is not in project workflow (404)', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        ok(buildAssignment({ status: 'unlisted_stage', isProjectMember: true }))
      );

      const app = appFor(TRANSLATOR, CHAPTER_ASSIGNMENT_ACTIONS.IS_PARTICIPANT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(404);
    });
  });

  describe('parameter validation & error forwarding', () => {
    it('returns 400 when assignment id is invalid', async () => {
      const app = appFor(MANAGER, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request('/assignments/abc', { method: 'POST' });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toEqual({ message: 'Missing chapter assignment ID' });
    });

    it('returns 404 when chapter assignment is not found in service', async () => {
      vi.mocked(chapterAssignmentService.getChapterAssignmentWithAuthContext).mockResolvedValue(
        err(ErrorCode.CHAPTER_ASSIGNMENT_NOT_FOUND)
      );

      const app = appFor(MANAGER, CHAPTER_ASSIGNMENT_ACTIONS.SUBMIT);
      const res = await app.request(`/assignments/${CHAPTER_ASSIGNMENT_ID}`, { method: 'POST' });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toEqual({ message: 'Chapter assignment not found' });
    });
  });
});
