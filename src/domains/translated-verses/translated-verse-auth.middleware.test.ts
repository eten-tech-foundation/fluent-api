import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { AppEnv } from '@/server/context.types';

import * as chapterAssignmentService from '@/domains/chapter-assignments/chapter-assignments.service';
import * as projectService from '@/domains/projects/projects.service';
import { resolveIsProjectMember } from '@/domains/projects/users/project-users.service';
import { getWorkflowStagesByProjectId } from '@/domains/projects/workflow-stages/workflow-stages.repository';
import { PERMISSIONS } from '@/lib/permissions';
import { err, ErrorCode, ErrorMessages } from '@/lib/types';

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

vi.mock('@/domains/chapter-assignments/chapter-assignments.service', () => ({
  getAssignmentForVerse: vi.fn(),
}));

vi.mock('@/domains/projects/workflow-stages/workflow-stages.repository', () => ({
  getWorkflowStagesByProjectId: vi.fn(),
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

  app.post(
    '/translated-verses',
    requireTranslatedVerseAccess(TRANSLATED_VERSE_ACTIONS.EDIT, PROJECT_UNIT_ID_SOURCES.BODY),
    (c) =>
      c.json({
        reached: true,
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

function postVerse(user: object, body: unknown) {
  return appFor(user).request('/translated-verses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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
      for (const id of ['abc', '0', '-1', '1.5', '2147483648', '0x10', '1e5']) {
        const res = await getVerse(MANAGER, id);

        expect(res.status, `id=${JSON.stringify(id)}`).toBe(400);
        expect(await res.json()).toEqual({ message: 'Missing verse ID' });
        expect(translatedVersesService.getTranslatedVerseById).not.toHaveBeenCalled();
      }
    });

    it('returns 404 when translated verse is not found in service', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue(
        err(ErrorCode.TRANSLATED_VERSE_NOT_FOUND)
      );

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Translated verse not found' });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 500 when verse lookup fails with a database error', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 404 when project unit is not found', async () => {
      vi.mocked(translatedVersesService.getTranslatedVerseById).mockResolvedValue({
        ok: true,
        data: mockVerse,
      });
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(
        err(ErrorCode.PROJECT_UNIT_NOT_FOUND)
      );

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
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
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
      vi.mocked(projectService.getProjectById).mockResolvedValue(err(ErrorCode.INTERNAL_ERROR));

      const res = await getVerse(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
    });

    it('denies user without access with 404', async () => {
      projectUnitResolves(false);

      const res = await getVerse(OTHER_ORG_MANAGER);

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ message: 'Translated verse not found' });
    });
  });

  describe('source: QUERY', () => {
    it('returns 400 when projectUnitId is missing or invalid in query', async () => {
      for (const query of [
        '',
        'projectUnitId=abc',
        'projectUnitId=0',
        'projectUnitId=-1',
        'projectUnitId=1.5',
        'projectUnitId=2147483648',
        'projectUnitId=0x10',
        'projectUnitId=1e5',
      ]) {
        const res = await listVerses(MANAGER, query);

        expect(res.status, `query=${JSON.stringify(query)}`).toBe(400);
        expect(await res.json()).toEqual({ message: 'Missing projectUnitId' });
        expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
      }
    });

    it('returns 500 when project unit lookup fails with DB error', async () => {
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const res = await listVerses(MANAGER);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
    });
  });

  describe('source: BODY, action: EDIT', () => {
    it('returns 400 when projectUnitId is missing or invalid in body', async () => {
      for (const projectUnitId of [undefined, 'abc', 0, -1, 1.5, 2147483648]) {
        const res = await postVerse(MANAGER, { projectUnitId, bibleTextId: 1 });

        expect(res.status, `projectUnitId=${JSON.stringify(projectUnitId)}`).toBe(400);
        expect(await res.json()).toEqual({ message: 'Missing projectUnitId' });
        expect(chapterAssignmentService.getAssignmentForVerse).not.toHaveBeenCalled();
      }
    });

    it('returns 500 when chapter assignment lookup fails with database error', async () => {
      vi.mocked(chapterAssignmentService.getAssignmentForVerse).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const res = await postVerse(MANAGER, { projectUnitId: PROJECT_UNIT_ID, bibleTextId: 1 });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
      expect(projectService.getProjectIdByUnitId).not.toHaveBeenCalled();
    });

    it('returns 500 when unit lookup fails with database error after assignment lookup succeeds', async () => {
      vi.mocked(chapterAssignmentService.getAssignmentForVerse).mockResolvedValue({
        ok: true,
        data: {
          id: 1,
          chapterAssignmentId: 1,
          chapterNumber: 1,
          bookId: 1,
          assignedUserId: 1,
          status: 'draft',
        } as never,
      });
      vi.mocked(projectService.getProjectIdByUnitId).mockResolvedValue(
        err(ErrorCode.INTERNAL_ERROR)
      );

      const res = await postVerse(MANAGER, { projectUnitId: PROJECT_UNIT_ID, bibleTextId: 1 });

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ message: ErrorMessages[ErrorCode.INTERNAL_ERROR] });
      expect(resolveIsProjectMember).not.toHaveBeenCalled();
      expect(getWorkflowStagesByProjectId).not.toHaveBeenCalled();
    });
  });
});
