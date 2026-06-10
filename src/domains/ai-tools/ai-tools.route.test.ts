import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@/db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/domains/users/users.service', () => ({
  getUserByEmail: vi.fn(),
}));

vi.mock('@/domains/user-roles/user-roles.repository', () => ({
  findGrantsByUserId: vi.fn(),
}));

vi.mock('./ai-tools.service', () => ({
  callRepeatedWords: vi.fn(),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_BODY = {
  lang_code: 'eng',
  lang_name: 'English',
  project_id: 1,
  project_name: 'Test Project',
  verses: [{ snt_id: 'GEN 1:1', text: 'In in the beginning' }],
};

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
function asAuthenticatedUser(granted: boolean) {
  (auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 1e9) },
    user: { email: APP_USER.email },
  });
  (getUserByEmail as any).mockResolvedValue({ ok: true, data: APP_USER });
  (findGrantsByUserId as any).mockResolvedValue({
    ok: true,
    data: granted
      ? [{ orgId: null, projectId: null, permissions: new Set([PERMISSIONS.AI_TOOLS_USE]) }]
      : [],
  });
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

  it('forwards the request body verbatim (no enrichment)', async () => {
    asAuthenticatedUser(true);
    (callRepeatedWords as any).mockResolvedValue({ ok: true, data: buildEnvelope() });

    await postRepeatedWords(VALID_BODY);

    expect(callRepeatedWords).toHaveBeenCalledOnce();
    expect(callRepeatedWords).toHaveBeenCalledWith(VALID_BODY);
  });
});
