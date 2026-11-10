import { describe, expect, it } from 'vitest';

import type { AssistantGenerationInput } from './assistant.generation-input';

import { generationInputFingerprint, providerRequest } from './assistant.generation-input';

const input = (overrides: Partial<AssistantGenerationInput> = {}): AssistantGenerationInput => ({
  artifactKind: 'passage_briefing',
  message: 'exact prompt',
  history: [],
  responseLanguageHint: 'en',
  outputConstraints: {
    contractVersion: 'fluent-widgets-v1',
    maxBytes: 60_000,
    completionMustMatchStream: true,
    requireNonBlank: true,
  },
  cacheEpoch: '1',
  ...overrides,
});

describe('canonical Assistant generation input', () => {
  it.each([
    ['artifact kind', { artifactKind: 'passage_turn' as const }],
    ['message', { message: 'changed prompt' }],
    ['history', { history: [{ user_message: 'q', assistant_response: 'a' }] }],
    ['language', { responseLanguageHint: 'hi' }],
    ['output contract', { outputConstraints: { ...input().outputConstraints, maxBytes: 10 } }],
    ['cache epoch', { cacheEpoch: '2' }],
  ])('fingerprints the exact %s', (_label, change) => {
    expect(generationInputFingerprint(input(change))).not.toBe(generationInputFingerprint(input()));
  });

  it('constructs the provider request from the same message, history and language values', () => {
    const canonical = input({
      history: [{ user_message: 'question', assistant_response: 'answer' }],
    });
    expect(providerRequest(canonical, 'fluent_17')).toEqual({
      userId: 'fluent_17',
      message: canonical.message,
      history: canonical.history,
      responseLanguageHint: canonical.responseLanguageHint,
    });
    expect(Object.keys(canonical).sort()).toEqual([
      'artifactKind',
      'cacheEpoch',
      'history',
      'message',
      'outputConstraints',
      'responseLanguageHint',
    ]);
  });
});
