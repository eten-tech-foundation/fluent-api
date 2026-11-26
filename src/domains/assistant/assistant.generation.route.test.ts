import { beforeEach, expect, it, vi } from 'vitest';

import {
  assistantRouteMocks,
  authenticate,
  config,
  post,
  resetAssistantRouteTestFixture,
  user,
  validBody,
} from './assistant.route.test-fixtures';

const { acquireGeneration } = assistantRouteMocks;

beforeEach(async () => {
  await resetAssistantRouteTestFixture();
  authenticate();
});

it('rejects new shared and bypass work before streaming but permits cache hits while busy', async () => {
  const release = acquireGeneration(user.id)!;
  try {
    for (const ignore_cache of [false, true]) {
      const response = await post({ ...validBody, ignore_cache });
      expect(response.status).toBe(429);
      expect(await response.json()).toEqual({
        code: 'generation_busy',
        retryable: true,
        retryAfter: 1,
      });
    }
    expect(assistantRouteMocks.BtServantClient).not.toHaveBeenCalled();
    vi.mocked(assistantRouteMocks.findCompletedArtifact).mockResolvedValue({
      cacheKey: 'a'.repeat(64),
      markdown: 'cached',
      cacheEpoch: config.cacheEpoch,
      outputContractVersion: 'fluent-widgets-v1',
    });
    const hit = await post(validBody);
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain('"cacheHit":true');
  } finally {
    release();
  }
  vi.mocked(assistantRouteMocks.findCompletedArtifact).mockResolvedValue(null);
  expect(await (await post(validBody)).text()).toContain('event: briefing_complete');
});

it('isolates admission by authenticated user and reuses a released slot safely', () => {
  const first = acquireGeneration(1001)!;
  const other = acquireGeneration(1002)!;
  try {
    expect(acquireGeneration(1001)).toBeNull();
    expect(other).toBeTypeOf('function');
    first();
    const second = acquireGeneration(1001)!;
    try {
      first();
      expect(acquireGeneration(1001)).toBeNull();
    } finally {
      second();
    }
  } finally {
    first();
    other();
  }
});

it('validates client templates, isolates them from shared prompting, and uses them privately', async () => {
  await (await post(validBody)).text();
  const key = vi.mocked(assistantRouteMocks.findCompletedArtifact).mock.calls[0][0];
  const actions = [
    {
      type: 'suggested_question',
      purpose: 'Offer a follow-up',
      template: '{{fluent:v1:suggested_question|QUESTION}}',
    },
  ];
  await (await post({ ...validBody, actions })).text();
  expect(vi.mocked(assistantRouteMocks.findCompletedArtifact).mock.calls[1][0]).toBe(key);
  const shared = vi.mocked(assistantRouteMocks.BtServantClient).mock.results[1].value;
  expect(shared.stream.mock.calls[0][0].message).not.toContain(JSON.stringify(actions));

  await (await post({ ...validBody, actions, ignore_cache: true })).text();
  const privateGeneration = vi.mocked(assistantRouteMocks.BtServantClient).mock.results[2].value;
  expect(privateGeneration.stream.mock.calls[0][0].message).toContain(JSON.stringify(actions));
  const invalid = await post({ ...validBody, actions: [{ ...actions[0], handler: 'code' }] });
  expect(invalid.status).toBe(400);
});
