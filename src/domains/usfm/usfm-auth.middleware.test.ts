import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ErrorMessages } from '@/lib/types';

import { requireProjectUnitAccess } from './usfm-auth.middleware';

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
  getProjectIdByUnitId: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

const PROJECT_ID = 7;
const PROJECT_UNIT_ID = 42;
const ORG = 1;
const OTHER_ORG = 2;
const OTHER_PROJECT = 8;

function viewGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) };
}

const MANAGER = { id: 1, grants: [viewGrant(ORG, null)] };
const OTHER_ORG_MANAGER = { id: 1, grants: [viewGrant(OTHER_ORG, null)] };
const TRANSLATOR = { id: 2, grants: [viewGrant(ORG, OTHER_PROJECT)] };

function buildProject(overrides: Partial<ProjectWithLanguageNames> = {}): ProjectWithLanguageNames {
  return {
    id: PROJECT_ID,
    name: 'Test Project',
    organization: ORG,
    sourceLanguageId: 1,
    targetLanguageId: 2,
    sourceLanguageName: 'English',
    targetLanguageName: 'Spanish',
    sourceName: 'Test Bible',
    isActive: true,
    status: 'active',
    createdBy: 1,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    metadata: {},
    sourceBibleId: null,
    pericopeSetId: null,
    lastActivityAt: null,
    lastChapterActivity: null,
    chapterStatusCounts: {},
    milestoneCount: 0,
    workflowConfig: [],
    ...overrides,
  };
}

const project = buildProject();

const DENIED = { status: 404, body: { message: 'Project not found' } };

function appFor(user: object, paramName?: string) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  const routePath =
    paramName === undefined
      ? '/project-units/:projectUnitId/usfm/books'
      : `/units/:${paramName}/usfm/books`;

  app.get(
    routePath,
    paramName === undefined ? requireProjectUnitAccess() : requireProjectUnitAccess(paramName),
    (c) =>
      c.json({
        reached: true,
        projectId: c.get('project')?.id ?? null,
        isProjectMember: c.get('projectAuthContext')?.isProjectMember ?? null,
      })
  );

  return app;
}

function get(user: object, projectUnitId: number | string = PROJECT_UNIT_ID) {
  return appFor(user).request(`/project-units/${projectUnitId}/usfm/books`);
}

function projectUnitResolves(isProjectMember = false) {
  vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
    ok: true,
    data: { projectId: PROJECT_ID },
  });
  vi.mocked(projectService.getProjectById).mockResolvedValue({ ok: true, data: project });
  vi.mocked(resolveIsProjectMember).mockResolvedValue(isProjectMember);
}

describe('requireProjectUnitAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a manager of the owning organization through, with the project in context', async () => {
    projectUnitResolves();

    const res = await get(MANAGER);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reached: true,
      projectId: PROJECT_ID,
      isProjectMember: false,
    });
    expect(projectService.getProjectIdByUnitId).toHaveBeenCalledWith(PROJECT_UNIT_ID);
    expect(projectService.getProjectById).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('denies a manager from another organization', async () => {
    projectUnitResolves();

    const res = await get(OTHER_ORG_MANAGER);

    expect(res.status).toBe(DENIED.status);
    expect(await res.json()).toEqual(DENIED.body);
  });

  it('lets a translator through only when they are a member of the project', async () => {
    projectUnitResolves(true);

    const member = await get(TRANSLATOR);
    expect(member.status).toBe(200);
    expect(await member.json()).toEqual({
      reached: true,
      projectId: PROJECT_ID,
      isProjectMember: true,
    });
    expect(resolveIsProjectMember).toHaveBeenCalledWith(PROJECT_ID, TRANSLATOR.id);
  });

  it('denies a translator who is not a member, even inside the owning organization', async () => {
    projectUnitResolves(false);

    const res = await get(TRANSLATOR);

    expect(res.status).toBe(DENIED.status);
    expect(await res.json()).toEqual(DENIED.body);
  });

  it('denies when the project unit does not exist (404)', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(
      err(ErrorCode.PROJECT_UNIT_NOT_FOUND)
    );

    const res = await get(MANAGER);

    expect(res.status).toBe(DENIED.status);
    expect(await res.json()).toEqual(DENIED.body);
    expect(projectService.getProjectById).not.toHaveBeenCalled();
  });

  it('denies when the project unit resolves but the project does not (404)', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: true,
      data: { projectId: PROJECT_ID },
    });
    vi.mocked(projectService.getProjectById).mockResolvedValue(err(ErrorCode.PROJECT_NOT_FOUND));

    const res = await get(MANAGER);

    expect(res.status).toBe(DENIED.status);
    expect(resolveIsProjectMember).not.toHaveBeenCalled();
  });

  it('rejects a malformed project unit ID without touching the database (400)', async () => {
    for (const projectUnitId of ['abc', '0', '-1', '1.5', '2147483648', '0x10', '1e5']) {
      const res = await get(MANAGER, projectUnitId);

      expect(res.status, `projectUnitId=${JSON.stringify(projectUnitId)}`).toBe(400);
      expect(await res.json()).toEqual({ message: 'Missing projectUnitId' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    }
  });

  it('returns 500 when looking up the project unit fails with a database error', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const res = await get(MANAGER);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
    expect(projectService.getProjectById).not.toHaveBeenCalled();
  });

  it('returns 500 when looking up the project fails with a database error', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: true,
      data: { projectId: PROJECT_ID },
    });
    vi.mocked(projectService.getProjectById).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

    const res = await get(MANAGER);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
    expect(resolveIsProjectMember).not.toHaveBeenCalled();
  });

  it('reads the project unit from the parameter it was given', async () => {
    projectUnitResolves();

    const res = await appFor(MANAGER, 'unitId').request(`/units/${PROJECT_UNIT_ID}/usfm/books`);

    expect(res.status).toBe(200);
    expect(projectService.getProjectIdByUnitId).toHaveBeenCalledWith(PROJECT_UNIT_ID);
  });
});
