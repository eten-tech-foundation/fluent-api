import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { PERMISSIONS } from '@/lib/permissions';

import { requireBookDetailsAccess } from './book-details-auth.middleware';

// The record-level check the route test deliberately stubs out (#275 review). The
// route test mocks this middleware to a pass-through, so it says nothing about
// project scoping; everything the middleware decides is pinned here instead.
//
// Mocked at the service boundary rather than the database, because the middleware's
// contract is "given these three lookups, allow or deny" — the lookups themselves
// have their own tests, and reaching for a real database would test drizzle.

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
  getProjectIdByUnitId: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 7;
const PROJECT_UNIT_ID = 42;
const ORG = 1;
const OTHER_ORG = 2;
const OTHER_PROJECT = 8;

/** A grant carrying project:view over the given scope — all that ProjectPolicy.read consults. */
function viewGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) };
}

// Org-wide view over the owning organization: an Org Manager's grant shape.
const MANAGER = { id: 1, grants: [viewGrant(ORG, null)] };
// The same shape over a different organization, which must not apply here.
const OTHER_ORG_MANAGER = { id: 1, grants: [viewGrant(OTHER_ORG, null)] };
// A translator's grants are pinned per project, so for THIS project only the
// membership lookup can let them in (ProjectPolicy.read's fallback).
const TRANSLATOR = { id: 2, grants: [viewGrant(ORG, OTHER_PROJECT)] };

// Only `id` and `organization` are read, by ProjectPolicy.read.
const project = { id: PROJECT_ID, organization: ORG } as unknown as ProjectWithLanguageNames;

const DENIED = { status: 404, body: { message: 'Project not found' } };

/**
 * Mounts the middleware on a throwaway app. The terminal handler reports what the
 * middleware wrote into the context, so "allowed" means `next()` actually ran
 * rather than merely "did not 404".
 */
function appFor(user: object, paramName?: string) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  const routePath =
    paramName === undefined
      ? '/project-units/:projectUnitId/book-details'
      : `/units/:${paramName}/book-details`;

  app.get(
    routePath,
    paramName === undefined ? requireBookDetailsAccess() : requireBookDetailsAccess(paramName),
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
  return appFor(user).request(`/project-units/${projectUnitId}/book-details`);
}

/** The happy path for the lookups, so each test only overrides what it is about. */
function projectUnitResolves(isProjectMember = false) {
  vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
    ok: true,
    data: { projectId: PROJECT_ID },
  });
  vi.mocked(projectService.getProjectById).mockResolvedValue({ ok: true, data: project });
  vi.mocked(resolveIsProjectMember).mockResolvedValue(isProjectMember);
}

describe('requireBookDetailsAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets a manager of the owning organization through, with the project in context', async () => {
    projectUnitResolves();

    const res = await get(MANAGER);

    expect(res.status).toBe(200);
    // Not just "allowed": the middleware is also the only thing that populates
    // `project` and `projectAuthContext`, which handlers downstream read.
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
    // Same organization as the project, so only the membership lookup separates
    // this from the allowed case above — org membership alone must not be enough.
    projectUnitResolves(false);

    const res = await get(TRANSLATOR);

    expect(res.status).toBe(DENIED.status);
    expect(await res.json()).toEqual(DENIED.body);
  });

  it('lets a user through on a grant pinned to this exact project, membership aside', async () => {
    // The other side of the translator cases: a view grant pinned to (org, project)
    // applies directly, so no membership row is needed for this one.
    projectUnitResolves(false);

    const res = await get({ id: 3, grants: [viewGrant(ORG, PROJECT_ID)] });

    expect(res.status).toBe(200);
  });

  it('denies when the project unit does not exist', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: false,
      error: { code: 'PROJECT_UNIT_NOT_FOUND', message: 'Project unit not found' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(DENIED.status);
    expect(await res.json()).toEqual(DENIED.body);
    // Short-circuits: no point asking for a project we could not resolve.
    expect(projectService.getProjectById).not.toHaveBeenCalled();
  });

  it('denies when the project unit resolves but the project does not', async () => {
    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: true,
      data: { projectId: PROJECT_ID },
    });
    vi.mocked(projectService.getProjectById).mockResolvedValue({
      ok: false,
      error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } as never,
    });

    const res = await get(MANAGER);

    expect(res.status).toBe(DENIED.status);
    expect(resolveIsProjectMember).not.toHaveBeenCalled();
  });

  it('rejects a malformed project unit ID without touching the database', async () => {
    for (const projectUnitId of ['abc', '0', '-1', '1.5', '']) {
      const res = await get(MANAGER, projectUnitId);

      expect(res.status, `projectUnitId=${JSON.stringify(projectUnitId)}`).toBe(DENIED.status);
      // The guard exists to keep NaN and fractional IDs away from an integer
      // column, so the lookups must not run at all.
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    }
  });

  it('answers every denial identically, so project units cannot be enumerated', async () => {
    // The deliberate design: 404 with one message for "does not exist", "not your
    // organization" and "not assigned to you" alike. A 403 on any of these would
    // confirm the project unit exists, which is exactly what must stay hidden.
    const responses: Response[] = [];

    projectUnitResolves();
    responses.push(await get(OTHER_ORG_MANAGER));

    projectUnitResolves(false);
    responses.push(await get(TRANSLATOR));

    vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
      ok: false,
      error: { code: 'PROJECT_UNIT_NOT_FOUND', message: 'Project unit not found' } as never,
    });
    responses.push(await get(MANAGER));

    for (const res of responses) {
      expect(res.status).toBe(DENIED.status);
      expect(await res.json()).toEqual(DENIED.body);
    }
  });

  it('reads the project unit from the parameter it was given', async () => {
    projectUnitResolves();

    const res = await appFor(MANAGER, 'unitId').request(`/units/${PROJECT_UNIT_ID}/book-details`);

    expect(res.status).toBe(200);
    expect(projectService.getProjectIdByUnitId).toHaveBeenCalledWith(PROJECT_UNIT_ID);
  });
});
