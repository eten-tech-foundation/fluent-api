import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MockBtInstance } from './assistant.route.test-fixtures';

import {
  assistantRouteMocks,
  authenticate,
  config,
  post,
  resetAssistantRouteTestFixture,
  validBody,
} from './assistant.route.test-fixtures';

const {
  BtServantClient,
  findCompletedBriefing,
  findProjectSourceLanguage,
  loadAssistantConfig,
  publishCompletedBriefing,
  resolveCanonicalPassage,
  server,
} = assistantRouteMocks;

describe('assistant briefing route contract', () => {
  beforeEach(async () => {
    await resetAssistantRouteTestFixture();
  });

  it('requires authentication before resolving project or source context', async () => {
    expect((await post(validBody)).status).toBe(401);
    expect(resolveCanonicalPassage).not.toHaveBeenCalled();
    expect(findCompletedBriefing).not.toHaveBeenCalled();
  });

  it('enforces project-scoped read access', async () => {
    authenticate(false);
    expect((await post(validBody)).status).toBe(404);
    expect(resolveCanonicalPassage).not.toHaveBeenCalled();
  });

  it('serves both documented 400 envelopes from guards and request validation', async () => {
    authenticate();
    const invalidProject = await post(validBody, { projectId: 0 });
    expect(invalidProject.status).toBe(400);
    expect(await invalidProject.json()).toEqual({ message: 'Missing project ID' });

    const invalidBody = await post({ bookCode: 'MAT' });
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toEqual({ code: 'invalid_request', retryable: false });
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

    const instance = vi.mocked(BtServantClient).mock.instances[0] as unknown as MockBtInstance;
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
    const first = vi.mocked(BtServantClient).mock.instances[0] as unknown as MockBtInstance;
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
      .mock.instances.map(
        (instance) => (instance as unknown as MockBtInstance).stream.mock.calls[0][0].message
      );
    expect(messages[0]).toContain('Required grounding resource language code: "hi"');
    expect(messages[0]).toContain('Supplemental grounding guidance');
    expect(messages[1]).toContain('Required grounding resource language code: "en"');
    expect(messages[2]).toContain('Required grounding resource language code: "hi"');
    expect(messages.every((message) => message.includes('"sourceLanguageCode":"eng"'))).toBe(true);
  });
});
