import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { PERMISSIONS } from '@/lib/permissions';

import type { TranslatedVerseResponse } from './translated-verses.types';

import { requireTranslatedVerseAccess } from './translated-verse-auth.middleware';
import * as translatedVersesService from './translated-verses.service';
import { PROJECT_UNIT_ID_SOURCES, TRANSLATED_VERSE_ACTIONS } from './translated-verses.types';

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
  getProjectIdByUnitId: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./translated-verses.service', () => ({
  getTranslatedVerseById: vi.fn(),
}));

const PROJECT_ID = 7;
const PROJECT_UNIT_ID = 42;
const VERSE_ID = 100;
const ORG = 1;
const OTHER_ORG = 2;

function viewGrant(orgId: number | null, projectId: number | null) {
  return { orgId, projectId, permissions: new Set([PERMISSIONS.PROJECT_VIEW]) };
}

const MANAGER = { id: 1, grants: [viewGrant(ORG, null)] };
const OTHER_ORG_MANAGER = { id: 1, grants: [viewGrant(OTHER_ORG, null)] };

const project = { id: PROJECT_ID, organization: ORG } as unknown as ProjectWithLanguageNames;

const mockVerse: TranslatedVerseResponse = {
  id: VERSE_ID,
  projectUnitId: PROJECT_UNIT_ID,
  content: 'In the beginning',
  markers: null,
  bibleTextId: 1,
  assignedUserId: 1,
  verseNumber: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function appFor(user: object) {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('user', user as never);
    return next();
  });

  app.get(
    '/translated-verses/:id',
    requireTranslatedVerseAccess(
      TRANSLATED_VERSE_ACTIONS.READ,
      PROJECT_UNIT_ID_SOURCES.VERSE_PARAM,
      'id'
    ),
    (c) =>
      c.json({
        reached: true,
        verseId: c.get('translatedVerse')?.id ?? null,
        projectId: c.get('project')?.id ?? null,
      })
  );

  app.get(
    '/translated-verses',
    requireTranslatedVerseAccess(TRANSLATED_VERSE_ACTIONS.READ, PROJECT_UNIT_ID_SOURCES.QUERY),
    (c) =>
      c.json({
        reached: true,
        projectId: c.get('project')?.id ?? null,
      })
  );

  return app;
}

function getVerse(user: object, id: number | string = VERSE_ID) {
  return appFor(user).request(`/translated-verses/${id}`);
}

function listVerses(user: object, query = `projectUnitId=${PROJECT_UNIT_ID}`) {
  return appFor(user).request(`/translated-verses?${query}`);
}

function projectUnitResolves(isProjectMember = false) {
  vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
    ok: true,
    data: mockVerse,
  });
  vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
    ok: true,
    data: { projectId: PROJECT_ID },
  });
  vi.mocked(projectService.getProjectById).mockResolvedValue({ ok: true, data: project });
  vi.mocked(resolveIsProjectMember).mockResolvedValue(isProjectMember);
}

describe('requireTranslatedVerseAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('source: VERSE_PARAM', () => {
    it('lets authorized user through and injects verse and project into context', async () => {
      projectUnitResolves();

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        reached: true,
        verseId: VERSE_ID,
        projectId: PROJECT_ID,
      });
      expect(translatedVersesService.getTranslatedVerseById).toHaveBeenCalledWith(VERSE_ID);
      expect(projectService.getProjectIdByUnitId).toHaveBeenCalledWith(PROJECT_UNIT_ID);
      expect(projectService.getProjectById).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('returns 400 when verse ID is invalid', async () => {
      const res = await getVerse(MANAGER, 'abc');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'Missing verse ID' });
      expect(translatedVersesService.getTranslatedVerseById).not.toHaveBeenCalled();
    });

    it('returns 404 when translated verse is not found in service', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: false,
        error: {
          code: 'TRANSLATED_VERSE_NOT_FOUND',
          message: 'Translated verse not found',
        } as never,
      });

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Translated verse not found' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 500 when verse lookup fails with a database error', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
      });

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'Internal server error' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 404 when project unit is not found', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: true,
        data: mockVerse,
      });
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
        ok: false,
        error: { code: 'PROJECT_UNIT_NOT_FOUND', message: 'Project unit not found' } as never,
      });

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Translated verse not found' });
      expect(projectService.getProjectById).not.toHaveBeenCalled();
    });

    it('returns 500 when looking up the project unit fails with a database error', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: true,
        data: mockVerse,
      });
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
      });

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'Internal server error' });
      expect(projectService.getProjectById).not.toHaveBeenCalled();
    });

    it('returns 500 when looking up the project fails with a database error', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: true,
        data: mockVerse,
      });
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
        ok: true,
        data: { projectId: PROJECT_ID },
      });
      vi.mocked(projectService.getProjectById).mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
      });

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'Internal server error' });
    });

    it('denies user without access with 404', async () => {
      projectUnitResolves(false);

      const res = await getVerse(OTHER_ORG_MANAGER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Translated verse not found' });
    });
  });

  describe('source: QUERY', () => {
    it('returns 400 when projectUnitId is missing from query', async () => {
      const res = await listVerses(MANAGER, '');

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ message: 'Missing projectUnitId' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 500 when project unit lookup fails with DB error', async () => {
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue({
        ok: false,
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } as never,
      });

      const res = await listVerses(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: 'Internal server error' });
    });
  });
});
