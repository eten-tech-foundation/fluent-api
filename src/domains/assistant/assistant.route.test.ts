import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import { BtServantClient } from './assistant.client';
import { loadAssistantConfig } from './assistant.config';
import { findProjectSourceLanguage, resolveCanonicalPassage } from './assistant.repository';
import './assistant.route';

vi.mock('@/lib/auth', () => ({
  auth: { api: { getSession: vi.fn() }, handler: vi.fn() },
}));
vi.mock('@/db', () => {
  const query: any = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => [{ activeOrgId: 1 }]),
  };
  return { db: { select: vi.fn(() => query), update: vi.fn(() => query) } };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/domains/users/users.service', () => ({ getUserByEmail: vi.fn() }));
vi.mock('@/domains/user-roles/user-roles.repository', () => ({ findGrantsByUserId: vi.fn() }));
vi.mock('@/domains/projects/projects.service', () => ({ getProjectById: vi.fn() }));
vi.mock('@/domains/projects/users/project-users.service', () => ({
  resolveIsProjectMember: vi.fn(async () => false),
}));
vi.mock('./assistant.config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./assistant.config')>();
  return { ...actual, loadAssistantConfig: vi.fn() };
});
vi.mock('./assistant.repository', () => ({
  findProjectSourceLanguage: vi.fn(async () => 'eng'),
  resolveCanonicalPassage: vi.fn(),
}));
vi.mock('./assistant.client', () => ({
  BtServantClient: vi.fn(function (this: any) {
    this.stream = vi.fn(async function* () {
      yield { type: 'briefing_delta', delta: 'brief' };
      yield { type: 'briefing_complete', markdown: 'brief' };
    });
  }),
}));

const user = {
  id: 17,
  email: 'assistant@example.test',
  status: 'verified' as const,
  lastActiveOrgId: 1,
};
const project = { id: 7, organization: 1, name: 'Project' };
const config = {
  baseUrl: 'https://bt.invalid',
  engineKey: 'fixture-only',
  org: 'fluent',
  languages: {
    en: {
      displayName: 'English',
      projectLanguageCodes: ['eng'],
      responseLanguageHint: 'en',
      guidanceSlug: 'default',
      defaultGrounding: 'en',
      grounding: { en: { resourceLanguage: 'en', instruction: 'Use English resources.' } },
    },
    hi: {
      displayName: 'हिन्दी',
      projectLanguageCodes: ['hin'],
      responseLanguageHint: 'hi',
      guidanceSlug: 'default',
      defaultGrounding: 'hi',
      grounding: {
        hi: { resourceLanguage: 'hi', instruction: 'Use Hindi resources.' },
        en: { resourceLanguage: 'en', instruction: 'Use English resources.' },
      },
    },
  },
  operationVersion: 'briefing-v1',
  cacheEpoch: '1',
  budgets: {
    connectMs: 10,
    idleMs: 20,
    totalMs: 30,
    maxInputBytes: 20_000,
    maxOutputBytes: 20_000,
    maxFrameBytes: 1_000_000,
  },
};

function authenticate(canReadProject = true) {
  vi.mocked(auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 10_000) },
    user: { email: user.email },
  });
  vi.mocked(getUserByEmail as any).mockResolvedValue(ok(user));
  vi.mocked(findGrantsByUserId as any).mockResolvedValue(
    ok([
      {
        orgId: 1,
        projectId: canReadProject ? 7 : 8,
        permissions: new Set([PERMISSIONS.PROJECT_VIEW]),
      },
    ])
  );
}

function post(body: Record<string, unknown>) {
  return server.request('/projects/7/assistant/briefing', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = { bookCode: 'MAT', chapter: 4, activeVerse: 25, outputLanguage: 'en' };

describe('assistant briefing route', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    config.budgets.maxInputBytes = 20_000;
    vi.mocked(loadAssistantConfig).mockReturnValue(config);
    vi.mocked(resolveCanonicalPassage).mockResolvedValue({
      sourceBible: 'Canonical Source',
      sourceLanguageCode: 'eng',
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'server source' }],
    });
    const projects = await import('@/domains/projects/projects.service');
    vi.mocked(projects.getProjectById as any).mockResolvedValue(ok(project));
  });

  it('requires authentication before resolving project or source context', async () => {
    vi.mocked(auth.api.getSession as any).mockResolvedValue(null);
    expect((await post(validBody)).status).toBe(401);
    expect(resolveCanonicalPassage).not.toHaveBeenCalled();
  });

  it('enforces project-scoped read access', async () => {
    authenticate(false);
    expect((await post(validBody)).status).toBe(404);
    expect(resolveCanonicalPassage).not.toHaveBeenCalled();
  });

  it('normalizes unavailable, unsupported-language, and invalid-reference failures', async () => {
    authenticate();
    vi.mocked(loadAssistantConfig).mockReturnValueOnce(null);
    expect(await (await post(validBody)).json()).toEqual({
      code: 'temporarily_unavailable',
      retryable: true,
    });
    expect((await post({ ...validBody, outputLanguage: 'missing' })).status).toBe(400);
    const inherited = await post({ ...validBody, outputLanguage: 'constructor' });
    expect(inherited.status).toBe(400);
    expect(await inherited.json()).toEqual({ code: 'unsupported_language', retryable: false });
    vi.mocked(resolveCanonicalPassage).mockResolvedValueOnce(null);
    expect(await (await post(validBody)).json()).toEqual({
      code: 'invalid_request',
      retryable: false,
    });
  });

  it('publishes only display metadata and the server-selected project-language default', async () => {
    authenticate();
    vi.mocked(findProjectSourceLanguage).mockResolvedValueOnce('hin');
    const response = await server.request('/projects/7/assistant/languages');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      languages: [
        { code: 'en', displayName: 'English' },
        { code: 'hi', displayName: 'हिन्दी' },
      ],
      defaultLanguage: 'hi',
      englishFallback: 'en',
    });
    expect(JSON.stringify(body)).not.toMatch(/responseLanguageHint|grounding|guidanceSlug/);
  });

  it('ignores browser source fields and emits a normalized successful stream', async () => {
    authenticate();
    const response = await post({ ...validBody, sourceText: 'browser supplied attack' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const body = await response.text();
    expect(body).toContain('event: briefing_started');
    expect(body).toContain('event: briefing_delta');
    expect(body).toContain('event: briefing_complete');

    const instance = vi.mocked(BtServantClient).mock.instances[0] as any;
    expect(instance.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'fluent_17',
        responseLanguageHint: 'en',
        message: expect.stringContaining('MAT 4:25\t"server source"'),
      }),
      expect.any(AbortSignal)
    );
    const upstream = instance.stream.mock.calls[0][0];
    expect(upstream.message).not.toContain('browser supplied attack');
  });

  it('accepts the exact input limit and rejects one-byte overflow before BT access', async () => {
    authenticate();
    await post(validBody);
    const first = vi.mocked(BtServantClient).mock.instances[0] as any;
    const bytes = Buffer.byteLength(first.stream.mock.calls[0][0].message);

    config.budgets.maxInputBytes = bytes;
    expect((await post(validBody)).status).toBe(200);
    const callsAtLimit = vi.mocked(BtServantClient).mock.calls.length;

    config.budgets.maxInputBytes = bytes - 1;
    const overflow = await post(validBody);
    expect(overflow.status).toBe(413);
    expect(await overflow.json()).toEqual({ code: 'context_too_large', retryable: false });
    expect(BtServantClient).toHaveBeenCalledTimes(callsAtLimit);
  });

  it('puts configured H/H, explicit H/E, and same-output grounding into outbound prompts', async () => {
    authenticate();
    const request = { ...validBody, outputLanguage: 'hi' };

    await post(request);
    await post({ ...request, grounding: 'english' });
    await post({ ...request, grounding: 'output_language' });

    const messages = vi
      .mocked(BtServantClient)
      .mock.instances.map((instance: any) => instance.stream.mock.calls[0][0].message);
    expect(messages[0]).toContain('Required grounding resource language code: "hi"');
    expect(messages[0]).toContain('Supplemental grounding guidance');
    expect(messages[1]).toContain('Required grounding resource language code: "en"');
    expect(messages[2]).toContain('Required grounding resource language code: "hi"');
    expect(messages.every((message) => message.includes('"sourceLanguageCode":"eng"'))).toBe(true);
  });
});
