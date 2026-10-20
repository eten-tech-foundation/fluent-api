import { beforeEach, describe, expect, it } from 'vitest';

import {
  beginBriefingCacheLookup,
  briefingCacheKey,
  findInFlightBriefing,
  installOrJoinBriefing,
  removeInFlightBriefing,
  resetInFlightBriefingsForTests,
  RetainedBriefingProducer,
  serializeBriefingCacheIdentity,
  shutdownInFlightBriefings,
} from './assistant.cache';

const base = {
  operationVersion: 'passage-briefing-v1',
  profileVersion: 'fluent-profile-v1',
  resourcePolicyVersion: 'fluent-resource-policy-v1',
  cacheEpoch: '1',
  maxOutputBytes: 96_000,
  language: {
    displayName: 'English',
    projectLanguageCodes: ['eng'],
    responseLanguageHint: 'en',
    guidanceSlug: 'default',
    defaultGrounding: 'en',
    grounding: { en: { resourceLanguage: 'en', instruction: 'Use English resources.' } },
  },
  resourceLanguage: 'en',
  groundingInstruction: 'Use English resources.',
  passage: {
    sourceBible: 'Canonical Source',
    sourceLanguageCode: 'eng',
    verses: [
      { bookCode: 'MAT', chapter: 4, verse: 25, text: 'First' },
      { bookCode: 'MAT', chapter: 5, verse: 1, text: 'Second' },
    ],
  },
};

describe('passage briefing semantic cache identity', () => {
  it('has a stable fixed-shape serialization and SHA-256 golden', () => {
    expect(serializeBriefingCacheIdentity(base)).toBe(
      '{"operation":"passage_briefing","operationVersion":"passage-briefing-v1","profileVersion":"fluent-profile-v1","resourcePolicyVersion":"fluent-resource-policy-v1","cacheEpoch":"1","outputValidation":{"maxBytes":96000},"outputContractVersion":"fluent-widgets-v1","widgetInventory":[{"type":"suggested_question","count":3,"grammar":"{{fluent:v1:suggested_question|VISIBLE QUESTION}}"}],"responseLanguageHint":"en","guidanceSlug":"default","grounding":{"resourceLanguage":"en","instruction":"Use English resources."},"source":{"bible":"Canonical Source","languageCode":"eng","verses":[{"reference":{"bookCode":"MAT","chapter":4,"verse":25},"text":"First"},{"reference":{"bookCode":"MAT","chapter":5,"verse":1},"text":"Second"}]}}'
    );
    expect(briefingCacheKey(base)).toBe(
      '4fc55039e379e2b45f62a5fc8dc033f7bb4ec024f24c6fabc035da3be1d12f2a'
    );
  });

  it.each([
    ['operation version', { operationVersion: 'passage-briefing-v2' }],
    ['profile version', { profileVersion: 'fluent-profile-v2' }],
    ['resource policy version', { resourcePolicyVersion: 'fluent-resource-policy-v2' }],
    ['epoch', { cacheEpoch: '2' }],
    ['output limit', { maxOutputBytes: 48_000 }],
    ['response language', { language: { ...base.language, responseLanguageHint: 'hi' } }],
    ['guidance profile', { language: { ...base.language, guidanceSlug: 'alternate' } }],
    ['resource language', { resourceLanguage: 'hi' }],
    ['resource instruction', { groundingInstruction: 'Use Hindi resources.' }],
    ['source Bible label', { passage: { ...base.passage, sourceBible: 'Another Source' } }],
    ['source language', { passage: { ...base.passage, sourceLanguageCode: 'hin' } }],
    [
      'source text',
      {
        passage: {
          ...base.passage,
          verses: [{ ...base.passage.verses[0], text: 'Changed' }, base.passage.verses[1]],
        },
      },
    ],
    ['source order', { passage: { ...base.passage, verses: [...base.passage.verses].reverse() } }],
    [
      'source reference',
      {
        passage: {
          ...base.passage,
          verses: [{ ...base.passage.verses[0], verse: 24 }, base.passage.verses[1]],
        },
      },
    ],
  ])('misses when %s changes', (_label, change) => {
    expect(briefingCacheKey({ ...base, ...change })).not.toBe(briefingCacheKey(base));
  });

  it('ignores display/config selector metadata when effective answer inputs are identical', () => {
    const equivalent = {
      ...base,
      language: {
        ...base.language,
        displayName: 'Anglais',
        projectLanguageCodes: ['en', 'eng'],
        defaultGrounding: 'alternate',
        grounding: {
          alternate: { resourceLanguage: 'en', instruction: 'Use English resources.' },
        },
      },
    };
    expect(briefingCacheKey(equivalent)).toBe(briefingCacheKey(base));
  });

  it('does not admit user or project execution identity into the semantic projection', () => {
    const executionScoped = { ...base, userId: 17, projectId: 7 };
    expect(briefingCacheKey(executionScoped)).toBe(briefingCacheKey(base));
    expect(serializeBriefingCacheIdentity(executionScoped)).not.toMatch(/userId|projectId/);
  });
});

describe('bT passage briefing retained in-flight producer', () => {
  beforeEach(() => resetInFlightBriefingsForTests());

  it('replays source and a settled terminal event to a late joiner', async () => {
    const producer = new RetainedBriefingProducer();
    producer.publish({ type: 'briefing_delta', delta: 'one' });
    producer.publish({ type: 'briefing_delta', delta: ' two' });
    producer.publish({ type: 'briefing_complete', markdown: 'one two' });
    const events = [];
    for await (const event of producer.subscribe()) events.push(event);
    expect(events).toEqual([
      { type: 'briefing_delta', delta: 'one' },
      { type: 'briefing_delta', delta: ' two' },
      { type: 'briefing_complete', markdown: 'one two' },
    ]);
  });

  it('detaches one subscriber without settling or cancelling the producer', async () => {
    const producer = new RetainedBriefingProducer();
    const controller = new AbortController();
    const detached = producer.subscribe(controller.signal);
    const first = detached.next();
    producer.publish({ type: 'briefing_delta', delta: 'first' });
    expect(await first).toEqual({
      value: { type: 'briefing_delta', delta: 'first' },
      done: false,
    });
    controller.abort();
    expect(await detached.next()).toEqual({ value: undefined, done: true });

    producer.publish({ type: 'briefing_delta', delta: 'second' });
    producer.publish({ type: 'briefing_complete', markdown: 'firstsecond' });
    const replay = [];
    for await (const event of producer.subscribe()) replay.push(event);
    expect(replay).toHaveLength(3);
  });

  it('checks detachment before every retained replay event', async () => {
    const producer = new RetainedBriefingProducer();
    producer.publish({ type: 'briefing_delta', delta: 'first' });
    producer.publish({ type: 'briefing_delta', delta: 'second' });
    producer.publish({ type: 'briefing_complete', markdown: 'firstsecond' });
    const controller = new AbortController();
    const replay = producer.subscribe(controller.signal);

    expect(await replay.next()).toEqual({
      value: { type: 'briefing_delta', delta: 'first' },
      done: false,
    });
    controller.abort();
    expect(await replay.next()).toEqual({ value: undefined, done: true });
  });

  it('does not retain repeated empty progress frames', async () => {
    const producer = new RetainedBriefingProducer();
    for (let index = 0; index < 10_000; index++)
      producer.publish({ type: 'briefing_delta', delta: '' });
    producer.publish({ type: 'briefing_delta', delta: 'content' });
    producer.publish({ type: 'briefing_complete', markdown: 'content' });

    const replay = [];
    for await (const event of producer.subscribe()) replay.push(event);
    expect(replay).toEqual([
      { type: 'briefing_delta', delta: 'content' },
      { type: 'briefing_complete', markdown: 'content' },
    ]);
  });

  it('installs synchronously, joins by hash, and removes only the matching producer', () => {
    const first = installOrJoinBriefing('a'.repeat(64));
    const joined = installOrJoinBriefing('a'.repeat(64));
    expect(first.installed).toBe(true);
    expect(joined).toEqual({ producer: first.producer, installed: false });
    removeInFlightBriefing('a'.repeat(64), new RetainedBriefingProducer());
    expect(findInFlightBriefing('a'.repeat(64))).toBe(first.producer);
    removeInFlightBriefing('a'.repeat(64), first.producer);
    expect(findInFlightBriefing('a'.repeat(64))).toBeUndefined();
  });

  it('retains a completed producer across a database-snapshot handoff straddle', async () => {
    const key = 'b'.repeat(64);
    const releaseLookup = beginBriefingCacheLookup(key);
    const { producer } = installOrJoinBriefing(key);
    producer.publish({ type: 'briefing_complete', markdown: 'winner' });
    removeInFlightBriefing(key, producer);

    // The SELECT that leased before publication can now return its old miss and still join.
    expect(findInFlightBriefing(key)).toBe(producer);
    const replay = [];
    for await (const event of producer.subscribe()) replay.push(event);
    expect(replay).toEqual([{ type: 'briefing_complete', markdown: 'winner' }]);
    releaseLookup();
    expect(findInFlightBriefing(key)).toBeUndefined();
  });

  it('aborts every producer, settles subscribers once, clears the registry, and rejects new work', async () => {
    const key = 'c'.repeat(64);
    const { producer } = installOrJoinBriefing(key);
    const first = producer.subscribe();
    const second = producer.subscribe();
    const firstTerminal = first.next();
    const secondTerminal = second.next();

    await shutdownInFlightBriefings();
    const terminal = {
      type: 'briefing_error',
      code: 'temporarily_unavailable',
      retryable: true,
    };
    expect(await firstTerminal).toEqual({ value: terminal, done: false });
    expect(await secondTerminal).toEqual({ value: terminal, done: false });
    expect(await first.next()).toEqual({ value: undefined, done: true });
    expect(await second.next()).toEqual({ value: undefined, done: true });
    expect(producer.upstreamSignal.aborted).toBe(true);
    expect(findInFlightBriefing(key)).toBeUndefined();

    const rejected = installOrJoinBriefing(key);
    expect(rejected.installed).toBe(false);
    expect((await rejected.producer.subscribe().next()).value).toEqual(terminal);
  });
});
