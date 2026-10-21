import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';

import * as projectsService from '@/domains/projects/projects.service';
import * as projectUsersService from '@/domains/projects/users/project-users.service';
import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ErrorCode } from '@/lib/types';
import { server } from '@/server/server';

import { callRepeatedWords } from './ai-tools.service';

import '@/domains/ai-tools/ai-tools.route';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@/lib/auth', () => ({
  auth: {
    api: { getSession: vi.fn() },
    handler: vi.fn(),
  },
}));

vi.mock('@/db', () => {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue([]),
  };
  return {
    db: { select: vi.fn().mockReturnValue(chain), insert: vi.fn(), update: vi.fn() },
  };
});

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('@/domains/projects/projects.service', () => ({
  getProjectById: vi.fn(),
  getProjectIdByUnitId: vi.fn(),
}));

vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(),
}));

vi.mock('./ai-tools.service', () => ({
  callRepeatedWords: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Deliberately a NON-identity mapping (unit 8 → project 4). The original suite
// used `project_id: 1`, the one id where a project_units.id happens to equal its
// projects.id, which is exactly how the #420 mix-up went unnoticed.
const PROJECT_UNIT_ID = 8;
const PROJECT_ID = 4;

const VALID_BODY = {
  lang_code: 'eng',
  lang_name: 'English',
  project_unit_id: PROJECT_UNIT_ID,
  verses: [{ snt_id: 'GEN 1:1', text: 'In in the beginning' }],
};

const PROJECT = {
  id: PROJECT_ID,
  name: 'Test Project',
  organization: 1,
} as ProjectWithLanguageNames;

const APP_USER = {
  id: 1,
  email: 'translator@example.com',
  role: 5,
  roleName: 'translator',
  organization: 1,
  status: 'verified' as const,
};

function buildEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    job_id: '11111111-1111-1111-1111-111111111111',
    tool: 'greek_room.repeated_words',
    status: 'completed',
    result: {
      lang_code: 'eng',
      provider: 'GreekRoom',
      check: 'RepeatedWords',
      findings: [],
      summary: { total_findings: 0, legitimate_count: 0, verse_count: 1 },
    },
    error: null,
    created_at: '2026-06-02T00:00:00.000Z',
    completed_at: '2026-06-02T00:00:01.000Z',
    ...overrides,
  };
}

/** Authenticate as APP_USER with the given permission grant. */
function asAuthenticatedUser(granted: boolean, isMember = true, projectOk = true) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: APP_USER });
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: granted
      ? [
          {
            orgId: 1,
            projectId: 1,
            permissions: new Set([PERMISSIONS.AI_TOOLS_USE, PERMISSIONS.PROJECT_VIEW]),
          },
        ]
      : [],
  });

  const getProjectIdByUnitId = vi.mocked(projectsService.getProjectIdByUnitId);
  const getProjectById = vi.mocked(projectsService.getProjectById);
  const resolveIsProjectMember = vi.mocked(projectUsersService.resolveIsProjectMember);

  getProjectIdByUnitId.mockImplementation(async (projectUnitId) =>
    projectUnitId === PROJECT_UNIT_ID
      ? { ok: true, data: { projectId: PROJECT_ID } }
      : {
          ok: false,
          error: { code: ErrorCode.PROJECT_UNIT_NOT_FOUND, message: 'Project unit not found' },
        }
  );

  if (projectOk) {
    getProjectById.mockImplementation(async (id) =>
      id === PROJECT_ID
        ? { ok: true, data: PROJECT }
        : { ok: false, error: { code: ErrorCode.PROJECT_NOT_FOUND, message: 'Project not found' } }
    );
  } else {
    getProjectById.mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.PROJECT_NOT_FOUND, message: 'Project not found' },
    });
  }

  resolveIsProjectMember.mockResolvedValue(isMember);
}

function postRepeatedWords(body: unknown, headers: Record<string, string> = {}) {
  return server.request('/ai/tools/greek-room/repeated-words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('pOST /ai/tools/greek-room/repeated-words', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when the caller is not authenticated', async () => {
    (auth.api.getSession as any).mockResolvedValue(null);

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(401);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller lacks AI_TOOLS_USE', async () => {
    asAuthenticatedUser(false);

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(403);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller cannot access the requested project', async () => {
    asAuthenticatedUser(true, false, false);

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(404);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('authorizes against the project that owns the unit, not the raw project_unit_id', async () => {
    asAuthenticatedUser(true);
    vi.mocked(callRepeatedWords).mockResolvedValue({ ok: true, data: buildEnvelope() as never });

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(200);
    expect(projectsService.getProjectIdByUnitId).toHaveBeenCalledWith(PROJECT_UNIT_ID);
    expect(projectsService.getProjectById).toHaveBeenCalledWith(PROJECT_ID);
    expect(projectsService.getProjectById).not.toHaveBeenCalledWith(PROJECT_UNIT_ID);
    expect(projectUsersService.resolveIsProjectMember).toHaveBeenCalledWith(
      PROJECT_ID,
      APP_USER.id
    );
  });

  it('returns 404 when the project unit does not exist', async () => {
    asAuthenticatedUser(true);

    const res = await postRepeatedWords({ ...VALID_BODY, project_unit_id: 999 });

    expect(res.status).toBe(404);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 404 when the caller is not a member of the resolved project', async () => {
    asAuthenticatedUser(true, false);
    // Grants are scoped to project 1, so only membership could admit the
    // caller to project 4; with no membership the policy must deny.

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(404);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 400 when project_unit_id is missing', async () => {
    asAuthenticatedUser(true);
    const { project_unit_id: _omit, ...body } = VALID_BODY;

    const res = await postRepeatedWords(body);

    expect(res.status).toBe(400);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 400 when the body is invalid (empty verses)', async () => {
    asAuthenticatedUser(true);

    const res = await postRepeatedWords({ ...VALID_BODY, verses: [] });

    expect([400, 422]).toContain(res.status);
    expect(callRepeatedWords).not.toHaveBeenCalled();
  });

  it('returns 200 and passes the envelope through verbatim for a completed result', async () => {
    asAuthenticatedUser(true);
    const envelope = buildEnvelope();
    (callRepeatedWords as any).mockResolvedValue({ ok: true, data: envelope });

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(envelope);
  });

  it('returns 202 for a queued envelope', async () => {
    asAuthenticatedUser(true);
    const envelope = buildEnvelope({ status: 'queued', result: null, completed_at: null });
    (callRepeatedWords as any).mockResolvedValue({ ok: true, data: envelope });

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.status).toBe('queued');
  });

  it('returns 502 with the standard error shape when the tool execution failed', async () => {
    asAuthenticatedUser(true);
    (callRepeatedWords as any).mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.AI_TOOL_EXECUTION_FAILED, message: 'tool execution failed' },
    });

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(ErrorCode.AI_TOOL_EXECUTION_FAILED);
    expect(json.error).toBe('tool execution failed');
  });

  it('returns 502 when the upstream transport failed', async () => {
    asAuthenticatedUser(true);
    (callRepeatedWords as any).mockResolvedValue({
      ok: false,
      error: { code: ErrorCode.AI_SERVICE_UNAVAILABLE, message: 'fluent-ai unreachable' },
    });

    const res = await postRepeatedWords(VALID_BODY);

    expect(res.status).toBe(502);
    const json = await res.json();
    expect(json.code).toBe(ErrorCode.AI_SERVICE_UNAVAILABLE);
  });

  it('hands the service the validated body and the resolved project', async () => {
    asAuthenticatedUser(true);
    vi.mocked(callRepeatedWords).mockResolvedValue({ ok: true, data: buildEnvelope() as never });

    await postRepeatedWords(VALID_BODY);

    expect(callRepeatedWords).toHaveBeenCalledOnce();
    expect(callRepeatedWords).toHaveBeenCalledWith(
      VALID_BODY,
      expect.objectContaining({ id: PROJECT_ID, name: 'Test Project' })
    );
  });
});
