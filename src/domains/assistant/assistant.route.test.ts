/* eslint-disable max-lines, ts/no-explicit-any -- Vitest constructor/auth mocks expose overloaded framework types that cannot be represented faithfully. */
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { findGrantsByUserId } from '@/domains/user-roles/user-roles.repository';
import { getUserByEmail } from '@/domains/users/users.service';
import { auth } from '@/lib/auth';
import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { ok } from '@/lib/types';
import { server } from '@/server/server';

import { resetInFlightBriefingsForTests, shutdownInFlightBriefings } from './assistant.cache';
import { BtServantClient } from './assistant.client';
import { loadAssistantConfig } from './assistant.config';
import {
  findCompletedBriefing,
  findProjectSourceLanguage,
  publishCompletedBriefing,
  resolveCanonicalPassage,
} from './assistant.service';
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
vi.mock('./assistant.service', () => ({
  findProjectSourceLanguage: vi.fn(async () => 'eng'),
  resolveCanonicalPassage: vi.fn(),
  findCompletedBriefing: vi.fn(async () => null),
  publishCompletedBriefing: vi.fn(async () => true),
  requestExpiredBriefingCleanup: vi.fn(),
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
  profileVersion: 'fluent-profile-v1',
  resourcePolicyVersion: 'fluent-resource-policy-v1',
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

function authenticate(canReadProject = true, projectId = 7) {
  vi.mocked(auth.api.getSession as any).mockResolvedValue({
    session: { id: 's1', updatedAt: new Date(), expiresAt: new Date(Date.now() + 10_000) },
    user: { email: user.email },
  });
  vi.mocked(getUserByEmail as any).mockResolvedValue(ok(user));
  vi.mocked(findGrantsByUserId as any).mockResolvedValue(
    ok([
      {
        orgId: 1,
        projectId: canReadProject ? projectId : projectId + 1,
        permissions: new Set([PERMISSIONS.PROJECT_VIEW]),
      },
    ])
  );
}

function post(
  body: Record<string, unknown>,
  options: { projectId?: number; signal?: AbortSignal } = {}
) {
  return server.request(`/projects/${options.projectId ?? 7}/assistant/briefing`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: options.signal,
  });
}

const validBody = { bookCode: 'MAT', chapter: 4, activeVerse: 25, outputLanguage: 'en' };

describe('assistant briefing route', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetInFlightBriefingsForTests();
    vi.mocked(BtServantClient).mockImplementation(function (this: any) {
      this.stream = vi.fn(async function* () {
        yield { type: 'briefing_delta', delta: 'brief' };
        yield { type: 'briefing_complete', markdown: 'brief' };
      });
    } as any);
    vi.mocked(findCompletedBriefing).mockResolvedValue(null);
    vi.mocked(publishCompletedBriefing).mockResolvedValue(true);
    user.id = 17;
    config.budgets.maxInputBytes = 20_000;
    vi.mocked(loadAssistantConfig).mockReturnValue(config);
    vi.mocked(resolveCanonicalPassage).mockResolvedValue({
      sourceBible: 'Canonical Source',
      sourceLanguageCode: 'eng',
      verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'server source' }],
    });
    const projects = await import('@/domains/projects/projects.service');
    vi.mocked(projects.getProjectById as any).mockImplementation(async (id: number) =>
      ok({ ...project, id })
    );
  });

  it('requires authentication before resolving project or source context', async () => {
    vi.mocked(auth.api.getSession as any).mockResolvedValue(null);
    expect((await post(validBody)).status).toBe(401);
    expect(resolveCanonicalPassage).not.toHaveBeenCalled();
    expect(findCompletedBriefing).not.toHaveBeenCalled();
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
    expect(body).toContain('"cacheHit":false');

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
    expect(publishCompletedBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        cacheKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        markdown: 'brief',
        profileVersion: 'fluent-profile-v1',
        resourcePolicyVersion: 'fluent-resource-policy-v1',
      }),
      expect.any(AbortSignal)
    );
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

  it('replays an exact completed-row hit without BT and marks only that completion as a hit', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce({
      cacheKey: 'a'.repeat(64),
      markdown: 'cached briefing',
      operationVersion: 'briefing-v1',
      profileVersion: 'fluent-profile-v1',
      resourcePolicyVersion: 'fluent-resource-policy-v1',
      cacheEpoch: '1',
      outputContractVersion: 'fluent-widgets-v1',
      responseLanguageHint: 'en',
      resourceLanguage: 'en',
      sourceLanguageCode: 'eng',
    });

    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_started');
    expect(body).toContain('"delta":"cached briefing"');
    expect(body).toContain('"markdown":"cached briefing"');
    expect(body).toContain('"cacheHit":true');
    expect(BtServantClient).not.toHaveBeenCalled();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
  });

  it('runs ignore_cache privately and bypasses completed reads, joining, and writes', async () => {
    authenticate();
    const body = await (await post({ ...validBody, ignore_cache: true })).text();
    expect(body).toContain('"cacheHit":false');
    expect(findCompletedBriefing).not.toHaveBeenCalled();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    const instance = vi.mocked(BtServantClient).mock.instances[0] as any;
    expect(instance.stream).toHaveBeenCalledWith(expect.any(Object), expect.any(AbortSignal));
  });

  it('aborts a private ignore_cache producer when its request disconnects', async () => {
    authenticate();
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: any) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'private' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
    } as any);
    const request = new AbortController();
    const response = await post({ ...validBody, ignore_cache: true }, { signal: request.signal });
    const reader = response.body!.getReader();
    await reader.read();
    request.abort();
    await vi.waitFor(() => expect(upstreamSignal.aborted).toBe(true));
    await reader.cancel();
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(finished).toHaveLength(1);
      expect(finished[0][0]).toEqual(
        expect.objectContaining({ outcome: 'detached', durationMs: expect.any(Number) })
      );
    });
  });

  it('does not publish a failed or interrupted upstream result', async () => {
    authenticate();
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: any) {
      this.stream = vi.fn(async function* () {
        yield { type: 'briefing_delta', delta: 'partial' };
        yield { type: 'briefing_error', code: 'timed_out', retryable: true };
      });
    } as any);

    const body = await (await post(validBody)).text();
    expect(body).toContain('"delta":"partial"');
    expect(body).toContain('"code":"timed_out"');
    expect(body).not.toContain('event: briefing_complete');
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
  });

  it('treats the completed cache as disposable when its read or write fails', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockRejectedValueOnce(new Error('database unavailable'));
    vi.mocked(publishCompletedBriefing).mockRejectedValueOnce(new Error('database unavailable'));

    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(body).toContain('"markdown":"brief"');
    expect(body).toContain('"cacheHit":false');
  });

  it('degrades after a bounded repository read rejection', async () => {
    authenticate();
    vi.mocked(findCompletedBriefing).mockRejectedValueOnce(new Error('read timeout'));
    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(BtServantClient).toHaveBeenCalledTimes(1);
  });

  it('degrades after a cancelled repository write without losing valid BT output', async () => {
    authenticate();
    vi.mocked(publishCompletedBriefing).mockRejectedValueOnce(new Error('write timeout'));
    const body = await (await post(validBody)).text();
    expect(body).toContain('event: briefing_complete');
    expect(body).toContain('"cacheHit":false');
  });

  it.each([
    ['malformed', 'First paragraph.\n\nSecond paragraph.\n\n{{not-a-fluent-macro}}'],
    ['missing', 'First paragraph.\n\nSecond paragraph with no suggested questions.'],
  ])(
    'caches safe completed Markdown when suggested-question macros are %s',
    async (_kind, text) => {
      authenticate();
      vi.mocked(BtServantClient).mockImplementationOnce(function (this: any) {
        this.stream = vi.fn(async function* () {
          yield { type: 'briefing_delta', delta: text };
          yield { type: 'briefing_complete', markdown: text };
        });
      } as any);
      const body = await (await post(validBody)).text();
      expect(body).toContain('event: briefing_complete');
      expect(publishCompletedBriefing).toHaveBeenCalledWith(
        expect.objectContaining({ markdown: text }),
        expect.any(AbortSignal)
      );
    }
  );

  it('reuses one authorized semantic artifact across user and project identities', async () => {
    authenticate(true, 7);
    await (await post(validBody)).text();
    const firstKey = vi.mocked(findCompletedBriefing).mock.calls[0][0];
    const artifact = vi.mocked(publishCompletedBriefing).mock.calls[0][0];

    user.id = 29;
    authenticate(true, 8);
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce(artifact);
    const body = await (await post(validBody, { projectId: 8 })).text();
    expect(vi.mocked(findCompletedBriefing).mock.calls[1][0]).toBe(firstKey);
    expect(body).toContain('"cacheHit":true');
    expect(BtServantClient).toHaveBeenCalledTimes(1);
  });

  it('never logs the semantic key, source passage, prompt, or completed artifact', async () => {
    authenticate();
    await (await post(validBody)).text();
    const cacheKey = vi.mocked(publishCompletedBriefing).mock.calls[0][0].cacheKey;
    const logs = JSON.stringify([
      ...vi.mocked(logger.info).mock.calls,
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(logs).not.toContain(cacheKey);
    expect(logs).not.toContain('server source');
    expect(logs).not.toContain('Canonical Source');
    expect(logs).not.toContain('fluent_source_passage');
    expect(logs).not.toContain('"markdown"');
  });

  it('rechecks after concurrent database misses and starts one same-hash producer', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamStarts = 0;
    vi.mocked(BtServantClient).mockImplementation(function (this: any) {
      this.stream = vi.fn(async function* () {
        upstreamStarts++;
        yield { type: 'briefing_delta', delta: 'shared' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'shared' };
      });
    } as any);

    const responses = await Promise.all([post(validBody), post(validBody)]);
    await vi.waitFor(() => expect(upstreamStarts).toBe(1));
    release();
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.includes('"markdown":"shared"'))).toBe(true);
    expect(bodies.every((body) => body.includes('"cacheHit":false'))).toBe(true);
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);
    const finished = vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
    expect(finished).toHaveLength(2);
    expect(new Set(finished.map((call) => (call[0] as any).attemptId)).size).toBe(2);
    expect(finished.every((call) => (call[0] as any).outcome === 'briefing_complete')).toBe(true);
    expect(finished.every((call) => Number.isFinite((call[0] as any).durationMs))).toBe(true);
  });

  it('lets the last subscriber detach while the shared producer completes and writes', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementationOnce(function (this: any) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'retained' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'retained' };
      });
    } as any);
    const request = new AbortController();
    const response = await post(validBody, { signal: request.signal });
    await response.body!.getReader().read();
    request.abort();
    expect(upstreamSignal.aborted).toBe(false);
    release();
    await vi.waitFor(() => expect(publishCompletedBriefing).toHaveBeenCalledTimes(1));
    expect(upstreamSignal.aborted).toBe(false);
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(finished).toHaveLength(1);
      expect((finished[0][0] as any).outcome).toBe('detached');
    });
  });

  it('keeps one joined subscriber delivering when the other detaches', async () => {
    authenticate();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(BtServantClient).mockImplementation(function (this: any) {
      this.stream = vi.fn(async function* () {
        yield { type: 'briefing_delta', delta: 'joined' };
        await gate;
        yield { type: 'briefing_complete', markdown: 'joined' };
      });
    } as any);
    const detachedRequest = new AbortController();
    const [detached, remaining] = await Promise.all([
      post(validBody, { signal: detachedRequest.signal }),
      post(validBody),
    ]);
    await detached.body!.getReader().read();
    detachedRequest.abort();
    release();
    const body = await remaining.text();
    expect(body).toContain('"markdown":"joined"');
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const finished = vi
        .mocked(logger.info)
        .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
      expect(finished.map((call) => (call[0] as any).outcome).sort()).toEqual([
        'briefing_complete',
        'detached',
      ]);
    });
  });

  it('aborts and settles one terminal per attached subscriber on controlled shutdown', async () => {
    authenticate();
    let upstreamSignal!: AbortSignal;
    vi.mocked(BtServantClient).mockImplementation(function (this: any) {
      this.stream = vi.fn(async function* (_request, signal: AbortSignal) {
        upstreamSignal = signal;
        yield { type: 'briefing_delta', delta: 'partial' };
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
      });
    } as any);
    const responses = await Promise.all([post(validBody), post(validBody)]);
    await vi.waitFor(() => expect(upstreamSignal).toBeInstanceOf(AbortSignal));
    await shutdownInFlightBriefings();

    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(upstreamSignal.aborted).toBe(true);
    expect(bodies.every((body) => body.match(/event: briefing_error/g)?.length === 1)).toBe(true);
    expect(publishCompletedBriefing).not.toHaveBeenCalled();
    const finished = vi
      .mocked(logger.info)
      .mock.calls.filter((call) => call[1] === 'Assistant briefing finished');
    expect(finished).toHaveLength(2);
  });

  it('keeps a valid BT completion authoritative when shutdown interrupts its cache write', async () => {
    authenticate();
    let writeSignal!: AbortSignal;
    let wouldPersist = false;
    vi.mocked(publishCompletedBriefing).mockImplementationOnce(async (_artifact, signal) => {
      writeSignal = signal!;
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('query cancelled')), {
          once: true,
        });
      });
      wouldPersist = true;
      return true;
    });

    const response = await post(validBody);
    await vi.waitFor(() => expect(writeSignal).toBeInstanceOf(AbortSignal));
    await shutdownInFlightBriefings();
    const body = await response.text();

    expect(writeSignal.aborted).toBe(true);
    expect(wouldPersist).toBe(false);
    expect(body).toContain('event: briefing_complete');
    expect(body).not.toContain('event: briefing_error');
  });

  it('joins a producer when a stale database snapshot returns after publication and removal', async () => {
    authenticate();
    let finishStaleRead!: (value: null) => void;
    const staleRead = new Promise<null>((resolve) => {
      finishStaleRead = resolve;
    });
    vi.mocked(findCompletedBriefing).mockReturnValueOnce(staleRead).mockResolvedValueOnce(null);

    const straddler = post(validBody);
    await vi.waitFor(() => expect(findCompletedBriefing).toHaveBeenCalledTimes(1));
    const producerResponse = await post(validBody);
    await producerResponse.text();
    expect(publishCompletedBriefing).toHaveBeenCalledTimes(1);

    finishStaleRead(null);
    const straddlerBody = await (await straddler).text();
    expect(straddlerBody).toContain('"markdown":"brief"');
    const upstreamCalls = vi
      .mocked(BtServantClient)
      .mock.instances.reduce(
        (total, instance: any) => total + instance.stream.mock.calls.length,
        0
      );
    expect(upstreamCalls).toBe(1);
  });

  it('retains the producer through completed-row publication and hands later callers to PostgreSQL', async () => {
    authenticate();
    let finishPublish!: () => void;
    const publishing = new Promise<boolean>((resolve) => {
      finishPublish = () => resolve(true);
    });
    vi.mocked(publishCompletedBriefing).mockReturnValueOnce(publishing);

    const first = await post(validBody);
    await vi.waitFor(() => expect(publishCompletedBriefing).toHaveBeenCalledTimes(1));
    const joinedDuringPublish = await post(validBody);
    expect(findCompletedBriefing).toHaveBeenCalledTimes(1);
    finishPublish();

    const joinedBodies = await Promise.all([first.text(), joinedDuringPublish.text()]);
    expect(joinedBodies.every((body) => body.includes('"cacheHit":false'))).toBe(true);
    const published = vi.mocked(publishCompletedBriefing).mock.calls[0][0];
    vi.mocked(findCompletedBriefing).mockResolvedValueOnce(published);

    const afterRemoval = await (await post(validBody)).text();
    expect(afterRemoval).toContain('"cacheHit":true');
    const upstreamCalls = vi
      .mocked(BtServantClient)
      .mock.instances.reduce(
        (total, instance: any) => total + instance.stream.mock.calls.length,
        0
      );
    expect(upstreamCalls).toBe(1);
  });
});
