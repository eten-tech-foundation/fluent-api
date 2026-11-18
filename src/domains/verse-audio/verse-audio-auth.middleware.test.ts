import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorMessages } from '@/lib/types';

import { requireReadVerseAudioAccess } from './verse-audio-auth.middleware';
import { VERSE_AUDIO_ID_SOURCES } from './verse-audio.types';

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

function viewGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) };
}

const MANAGER = { id: 1, grants: [viewGrant(ORG, null)] };
const OTHER_ORG_MANAGER = { id: 1, grants: [viewGrant(OTHER_ORG, null)] };

const project = { id: PROJECT_ID, organization: ORG } as unknown as ProjectWithLanguageNames;

function appFor(user: object) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  app.get(
    '/verse-audio/:projectUnitId/1',
    requireReadVerseAudioAccess(VERSE_AUDIO_ID_SOURCES.PARAMS),
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
  return appFor(user).request(`/verse-audio/${projectUnitId}/1`);
}

function projectUnitResolves(isProjectMember = false) {
  vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
    ok: true,
    data: { projectId: PROJECT_ID },
  });
  vi.mocked(projectService.getProjectById).mockResolvedValue({ ok: true, data: project });
  vi.mocked(resolveIsProjectMember).mockResolvedValue(isProjectMember);
}

describe('requireReadVerseAudioAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets an authorized manager through, with project in context', async () => {
    projectUnitResolves();

    const res = await get(MANAGER);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      reached: true,
      projectId: PROJECT_ID,
      isProjectMember: false,
    });
  });

  it('rejects a malformed project unit ID with 400', async () => {
    for (const projectUnitId of ['abc', '0', '-1', '1.5']) {
      const res = await get(MANAGER, projectUnitId);

      expect(res.status, `projectUnitId=${JSON.stringify(projectUnitId)}`).toBe(400);
      expect(await res.json()).toEqual({ message: 'Missing projectUnitId' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    }
  });

  it('returns 404 when project unit is not found', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: false,
      error: { code: 'PROJECT_UNIT_NOT_FOUND', message: 'Project unit not found' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: ErrorMessages.VERSE_AUDIO_NOT_FOUND });
  });

  it('returns 404 when project is not found', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: true,
      data: { projectId: PROJECT_ID },
    });
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      ok: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: ErrorMessages.VERSE_AUDIO_NOT_FOUND });
  });

  it('returns 500 when looking up the project unit fails with a database error', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'Internal server error' });
    expect(projectService.getProjectById).not.toHaveBeenCalled();
  });

  it('returns 500 when looking up the project fails with a database error', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: true,
      data: { projectId: PROJECT_ID },
    });
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: 'Internal server error' });
  });

  it('denies user without access with 404', async () => {
    projectUnitResolves(false);

    const res = await get(OTHER_ORG_MANAGER);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: ErrorMessages.VERSE_AUDIO_NOT_FOUND });
  });
});
