import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectById } from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ok } from '@/lib/types';
import { server } from '@/server/server';

import * as service from './workflow-stages.service';
import './workflow-stages.route';

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const query = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([{ activeOrgId: 1 }]),
  };
  return {
    db: {
      select: vi.fn(() => query),
      insert: vi.fn(),
      update: vi.fn(),
    },
  };
});

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('./workflow-stages.service', () => ({
  getWorkflowStages: vi.fn(),
  addStage: vi.fn(),
  renameStage: vi.fn(),
  deleteStage: vi.fn(),
  reorderStages: vi.fn(),
}));

const project = { id: 1, organization: 1 } as any;
const stage = {
  id: 'community_review',
  label: 'Community Review',
  stageId: 4,
  position: 3,
  isFixed: false,
  isLocked: false,
};

function asAuthenticatedProjectManager() {
  vi.mocked(auth.api.getSession).mockResolvedValue({
    session: { id: 'session-1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: 'manager@example.com' },
  } as any);
  vi.mocked(getUserByEmail).mockResolvedValue(
    ok({ id: 1, email: 'manager@example.com', status: 'verified' } as any)
  );
  vi.mocked(findGrantsByUserId).mockResolvedValue(
    ok([
      {
        orgId: 1,
        projectId: 1,
        permissions: new Set([PERMISSIONS.PROJECT_VIEW, PERMISSIONS.PROJECT_UPDATE]),
      },
    ])
  );
  vi.mocked(getProjectById).mockResolvedValue(ok(project));
  vi.mocked(resolveIsProjectMember).mockResolvedValue(true);
}

describe('workflow stages routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('requires authentication', async () => {
    vi.mocked(auth.api.getSession).mockResolvedValue(null);

    const response = await server.request('/projects/1/workflow-stages');

    expect(response.status).toBe(401);
  });

  it('returns the workflow stages for an authorized project member', async () => {
    asAuthenticatedProjectManager();
    vi.mocked(service.getWorkflowStages).mockResolvedValue(ok([stage]));

    const response = await server.request('/projects/1/workflow-stages');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([stage]);
    expect(service.getWorkflowStages).toHaveBeenCalledWith(1);
  });

  it('returns a 409 for duplicate stage name conflict', async () => {
    asAuthenticatedProjectManager();
    vi.mocked(service.addStage).mockResolvedValue(err(ErrorCode.WORKFLOW_STAGE_DUPLICATE_NAME));

    const response = await server.request('/projects/1/workflow-stages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Existing Stage' }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: 'A stage with this name already exists' });
  });

  it('returns a 404 when stage is not found on rename', async () => {
    asAuthenticatedProjectManager();
    vi.mocked(service.renameStage).mockResolvedValue(err(ErrorCode.WORKFLOW_STAGE_NOT_FOUND));

    const response = await server.request('/projects/1/workflow-stages/999', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Renamed Stage' }),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'Workflow stage not found' });
  });

  it('forwards rename, delete, and reorder requests to the service', async () => {
    asAuthenticatedProjectManager();
    vi.mocked(service.renameStage).mockResolvedValue(ok(stage));
    vi.mocked(service.deleteStage).mockResolvedValue(ok([stage]));
    vi.mocked(service.reorderStages).mockResolvedValue(ok([stage]));

    const rename = await server.request('/projects/1/workflow-stages/4', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'Review' }),
    });
    const deletion = await server.request('/projects/1/workflow-stages/4', { method: 'DELETE' });
    const reorder = await server.request('/projects/1/workflow-stages/reorder', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stageIds: [1, 2, 3, 4] }),
    });

    expect(rename.status).toBe(200);
    expect(deletion.status).toBe(200);
    expect(reorder.status).toBe(200);
    expect(service.renameStage).toHaveBeenCalledWith(1, 4, 'Review');
    expect(service.deleteStage).toHaveBeenCalledWith(1, 4);
    expect(service.reorderStages).toHaveBeenCalledWith(1, [1, 2, 3, 4]);
  });
});
