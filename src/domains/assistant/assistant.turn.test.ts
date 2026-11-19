import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BtServantClient } from './assistant.client';
import { projectVerifiedTurn } from './assistant.turn.prompt';
import {
  assistantTurnEventSchema,
  assistantTurnRequestSchema,
  briefingIntegrityMetadataSchema,
  serializeTurnReceiptPayload,
  TURN_LIMITS,
  turnContextSchema,
  turnReceiptPayloadSchema,
} from './assistant.turn.types';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/turn-v1.json', import.meta.url), 'utf8')
);
const request = () => assistantTurnRequestSchema.parse(fixture.request);
const context = () => turnContextSchema.parse(fixture.context);
function conversation(count: number) {
  const value = request();
  value.turns = Array.from({ length: count }, (_, index) => ({
    turnId: `prior-${index}`,
    input: { text: `Question ${index}`, origin: 'typed' as const },
    selectedAttemptId: `prior-attempt-${index}`,
    attempts: [
      {
        attemptId: `prior-attempt-${index}`,
        operationId: `operation-${index}`,
        state: 'complete' as const,
        prefix: {
          markdown: `Answer ${index}`,
          sequence: 1,
          complete: true,
          receipt: 'fixture-only',
        },
      },
    ],
  }));
  return value;
}

describe('turn v1 shared contract', () => {
  it('accepts exact common fixtures and defaults to private cache misses', () => {
    expect(request()).toEqual(fixture.request);
    expect(context()).toEqual(fixture.context);
    for (const event of fixture.events)
      expect(assistantTurnEventSchema.parse(event)).toEqual(event);
    const { dont_cache: _hint, ...withoutHint } = request();
    expect(assistantTurnRequestSchema.parse(withoutHint).dont_cache).toBe(true);
    expect(
      assistantTurnRequestSchema.safeParse({ ...request(), providerUserId: 'bad' }).success
    ).toBe(false);
  });

  it('shares exact retry, empty and partial fixtures with Web', () => {
    expect(briefingIntegrityMetadataSchema.parse(fixture.briefingIntegrity)).toEqual(
      fixture.briefingIntegrity
    );
    for (const scenario of fixture.scenarios) {
      const result = projectVerifiedTurn(
        context(),
        assistantTurnRequestSchema.parse(scenario.request),
        5
      );
      expect(result.ok && result.generationInput.history, scenario.name).toEqual(scenario.history);
      expect(result.ok && result.projection.emptyTurnIds, scenario.name).toEqual(
        scenario.emptyTurnIds
      );
    }
  });

  it('serializes payloads in exact schema order regardless of insertion order', () => {
    for (const payload of fixture.payloads) {
      const parsed = turnReceiptPayloadSchema.parse(payload);
      const reverse = turnReceiptPayloadSchema.parse(
        Object.fromEntries(Object.entries(payload).reverse())
      );
      expect(serializeTurnReceiptPayload(reverse)).toBe(JSON.stringify(payload));
      expect(serializeTurnReceiptPayload(parsed)).toBe(JSON.stringify(payload));
    }
  });

  it('bounds exact input, receipt, output and identifier lengths without trimming', () => {
    const value = request();
    value.submission.input.text = ` ${'a'.repeat(TURN_LIMITS.inputChars - 2)} `;
    value.briefing.markdown = 'a'.repeat(60_001);
    value.contextReceipt = 'r'.repeat(TURN_LIMITS.receiptChars);
    value.submission.turnId = 'x'.repeat(64);
    expect(assistantTurnRequestSchema.parse(value)).toEqual(value);
    for (const oversized of [
      { ...value, contextReceipt: `${value.contextReceipt}x` },
      { ...value, submission: { ...value.submission, turnId: 'x'.repeat(65) } },
      {
        ...value,
        submission: { ...value.submission, input: { text: 'a'.repeat(4001), origin: 'typed' } },
      },
      { ...value, submission: { ...value.submission, input: { text: ' \n ', origin: 'typed' } } },
    ])
      expect(assistantTurnRequestSchema.safeParse(oversized).success).toBe(false);
  });

  it('bounds transcript turns, attempts and serialized bytes including escape expansion', () => {
    expect(assistantTurnRequestSchema.safeParse(conversation(49)).success).toBe(true);
    expect(assistantTurnRequestSchema.safeParse(conversation(50)).success).toBe(false);
    const value = conversation(10);
    for (const turn of value.turns) turn.attempts[0].prefix!.markdown = '\u0000'.repeat(15000);
    expect(assistantTurnRequestSchema.safeParse(value).success).toBe(false);
    const attempts = conversation(1);
    attempts.turns[0].attempts = Array.from({ length: 5 }, (_, i) => ({
      ...attempts.turns[0].attempts[0],
      attemptId: `attempt-${i}`,
    }));
    expect(assistantTurnRequestSchema.safeParse(attempts).success).toBe(false);
  });

  it('accepts exact serialized transcript/source budgets and rejects one byte more', () => {
    const value = conversation(30);
    for (const turn of value.turns) turn.attempts[0].prefix!.markdown = 'a'.repeat(10000);
    let remaining = TURN_LIMITS.transcriptBytes - Buffer.byteLength(JSON.stringify(value.turns));
    for (const turn of value.turns) {
      const added = Math.min(5000, remaining);
      turn.attempts[0].prefix!.markdown += 'a'.repeat(added);
      remaining -= added;
    }
    expect(remaining).toBe(0);
    expect(assistantTurnRequestSchema.safeParse(value).success).toBe(true);
    value.turns.at(-1)!.attempts[0].prefix!.markdown += 'a';
    expect(assistantTurnRequestSchema.safeParse(value).success).toBe(false);
    const source = context();
    source.verses[0].text = '';
    source.verses[0].text = 'a'.repeat(
      TURN_LIMITS.sourceBytes - Buffer.byteLength(JSON.stringify(source.verses))
    );
    expect(turnContextSchema.safeParse(source).success).toBe(true);
    source.verses[0].text += 'a';
    expect(turnContextSchema.safeParse(source).success).toBe(false);
  });

  it('rejects duplicate, missing-selection, completion and retry mismatches', () => {
    const value = conversation(2);
    value.turns[1].turnId = value.turns[0].turnId;
    expect(assistantTurnRequestSchema.safeParse(value).success).toBe(false);
    const missing = conversation(1);
    missing.turns[0].selectedAttemptId = 'missing';
    expect(assistantTurnRequestSchema.safeParse(missing).success).toBe(false);
    const mismatch = conversation(1);
    mismatch.turns[0].attempts[0].prefix!.complete = false;
    expect(assistantTurnRequestSchema.safeParse(mismatch).success).toBe(false);
    const retry = conversation(1);
    retry.submission.kind = 'retry';
    expect(assistantTurnRequestSchema.safeParse(retry).success).toBe(false);
  });

  it('bounds canonical source and event fields', () => {
    const value = context();
    value.verses[0].text = 'क'.repeat(11000);
    expect(turnContextSchema.safeParse(value).success).toBe(false);
    value.verses = Array.from({ length: 201 }, () => context().verses[0]);
    expect(turnContextSchema.safeParse(value).success).toBe(false);
    expect(
      assistantTurnEventSchema.safeParse({
        ...fixture.events[1],
        delta: 'x'.repeat(TURN_LIMITS.outputBytes + 1),
      }).success
    ).toBe(false);
    expect(
      assistantTurnEventSchema.safeParse({ ...fixture.events[3], retryAfter: 86401 }).success
    ).toBe(false);
    expect(
      turnReceiptPayloadSchema.safeParse({ ...fixture.payloads[0], contextDigest: 'invalid' })
        .success
    ).toBe(false);
  });
});

describe('verified provider projection', () => {
  it('retains newest five full pairs and repeats context beyond that window', () => {
    const result = projectVerifiedTurn(context(), conversation(7), 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.generationInput.history).toHaveLength(5);
    expect(result.generationInput.history[0].assistant_response).toBe('Answer 2');
    expect(result.projection).toEqual({
      historyWindow: 5,
      omittedTurnIds: ['prior-0', 'prior-1'],
      emptyTurnIds: [],
    });
    expect(result.generationInput.message.startsWith('#default @default\n')).toBe(true);
    expect(result.generationInput.message).toContain('In the beginning was the Word.');
    expect(result.generationInput.message).toContain('The Word was in the beginning.');
    expect(result.generationInput.message).toContain('language "en"');
    expect(result.generationInput.message).toContain(
      'Current question (JSON): "#help @hindi What does Word mean here?"'
    );
    expect(result.generationInput.message).not.toContain('fixture-context-not-a-signature');
  });

  it('uses a selected partial prefix for new input, excludes it for retry, skips empty attempts', () => {
    const value = conversation(2);
    value.turns[0].attempts[0] = { ...value.turns[0].attempts[0], state: 'failed', prefix: null };
    value.turns[1].attempts[0].state = 'interrupted';
    value.turns[1].attempts[0].prefix!.complete = false;
    const next = projectVerifiedTurn(context(), assistantTurnRequestSchema.parse(value), 5);
    expect(next.ok && next.generationInput.history).toEqual([
      {
        user_message: 'User question (JSON data): "Question 1"',
        assistant_response: '[Incomplete visible answer]\nAnswer 1',
      },
    ]);
    value.submission = {
      ...value.submission,
      kind: 'retry',
      turnId: 'prior-1',
      input: value.turns[1].input,
    };
    const retry = projectVerifiedTurn(context(), assistantTurnRequestSchema.parse(value), 5);
    expect(retry.ok && retry.generationInput.history).toEqual([]);
    expect(retry.ok && retry.projection.emptyTurnIds).toEqual(['prior-0']);
  });

  it('rejects oversized mandatory context or encoded history; never clips a field', () => {
    const value = request();
    value.briefing.markdown = '\u0000'.repeat(15000);
    expect(projectVerifiedTurn(context(), value, 5)).toEqual({
      ok: false,
      code: 'context_too_large',
    });
    const history = conversation(1);
    history.turns[0].input.text = '\u0000'.repeat(4000);
    expect(projectVerifiedTurn(context(), history, 5)).toEqual({
      ok: false,
      code: 'context_too_large',
    });
    for (const window of [0, 51, 1.5, Number.NaN])
      expect(projectVerifiedTurn(context(), request(), window)).toEqual({
        ok: false,
        code: 'invalid_request',
      });
  });

  it('enforces aggregate provider history bytes independently of the window', () => {
    const value = conversation(49);
    for (const turn of value.turns) turn.attempts[0].prefix!.markdown = 'क'.repeat(15000);
    expect(projectVerifiedTurn(context(), value, 50)).toEqual({
      ok: false,
      code: 'context_too_large',
    });
    expect(projectVerifiedTurn(context(), value, 5).ok).toBe(true);
  });

  it('accepts exact current-message and history-field limits, rejects one character more', () => {
    const source = context();
    source.verses[0].text = 'a'.repeat(31500);
    const value = request();
    value.briefing.markdown = '';
    const base = projectVerifiedTurn(source, value, 5);
    if (!base.ok) throw new Error('invalid boundary fixture');
    const remainingBytes =
      TURN_LIMITS.messageBytes - Buffer.byteLength(base.generationInput.message);
    value.briefing.markdown =
      'é'.repeat(Math.floor(remainingBytes / 2)) + 'a'.repeat(remainingBytes % 2);
    expect(assistantTurnRequestSchema.safeParse(value).success).toBe(true);
    const exact = projectVerifiedTurn(source, value, 5);
    expect(exact.ok && Buffer.byteLength(exact.generationInput.message)).toBe(
      TURN_LIMITS.messageBytes
    );
    value.briefing.markdown += 'a';
    expect(projectVerifiedTurn(source, value, 5)).toEqual({ ok: false, code: 'context_too_large' });
    const history = conversation(1);
    history.turns[0].input.text = '';
    const empty = projectVerifiedTurn(context(), history, 5);
    if (!empty.ok) throw new Error('invalid boundary fixture');
    const available =
      TURN_LIMITS.historyFieldChars - empty.generationInput.history[0].user_message.length;
    history.turns[0].input.text =
      '\u0000'.repeat(Math.floor(available / 6)) + 'a'.repeat(available % 6);
    expect(assistantTurnRequestSchema.safeParse(history).success).toBe(true);
    const full = projectVerifiedTurn(context(), history, 5);
    expect(full.ok && full.generationInput.history[0].user_message.length).toBe(
      TURN_LIMITS.historyFieldChars
    );
    history.turns[0].input.text += 'a';
    expect(projectVerifiedTurn(context(), history, 5)).toEqual({
      ok: false,
      code: 'context_too_large',
    });
  });

  it('keeps actor receipts and execution ids out of answer-affecting projection', () => {
    const value = conversation(1);
    const before = projectVerifiedTurn(context(), value, 5);
    value.contextReceipt = 'another-actor';
    value.briefing.receipt = 'another-delivery';
    value.submission.attemptId = 'new-execution';
    value.turns[0].attempts[0].operationId = 'another-operation';
    expect(projectVerifiedTurn(context(), value, 5)).toEqual(before);
  });

  it('passes explicit history and suppression through actual client normalization', async () => {
    const projected = projectVerifiedTurn(context(), conversation(1), 5);
    if (!projected.ok) throw new Error('fixture projection failed');
    let body: unknown;
    const client = new BtServantClient({
      baseUrl: 'https://bt.invalid',
      engineKey: 'fixture',
      org: 'fluent',
      connectMs: 1000,
      idleMs: 1000,
      totalMs: 1000,
      maxOutputBytes: 1000,
      maxFrameBytes: 1000,
      fetch: async (_url, init) => {
        body = JSON.parse(String(init?.body));
        return new Response('data: {"type":"complete","response":{"responses":["answer"]}}\n\n');
      },
    });
    const events = [];
    for await (const event of client.stream({
      ...projected.generationInput,
      userId: 'fixture-user',
    }))
      events.push(event);
    expect(body).toMatchObject({
      history: projected.generationInput.history,
      suppress_welcome: true,
      suppress_memory: true,
    });
    expect(events).toEqual([
      { type: 'briefing_replace', markdown: 'answer' },
      { type: 'briefing_complete', markdown: 'answer' },
    ]);
  });
});

it('uses the canonical catalog for shared turns and exact client catalog for private turns', () => {
  const original = conversation(7);
  const baseline = projectVerifiedTurn(context(), original, 5);
  expect(baseline.ok).toBe(true);
  if (!baseline.ok) return;
  const changedCatalog = projectVerifiedTurn(
    context(),
    {
      ...original,
      actions: [
        {
          type: 'suggested_question',
          purpose: 'Ask more',
          template: '{{fluent:v1:suggested_question|QUESTION}}',
        },
      ],
    },
    5
  );
  expect(changedCatalog.ok).toBe(true);
  if (!changedCatalog.ok) return;
  expect(changedCatalog.generationInput.message).not.toBe(baseline.generationInput.message);
  for (const changed of [
    { ...original, briefing: { ...original.briefing, markdown: 'Other briefing' } },
    { ...original, briefing: { ...original.briefing, complete: !original.briefing.complete } },
    {
      ...original,
      submission: {
        ...original.submission,
        input: { ...original.submission.input, text: 'Different question' },
      },
    },
  ]) {
    const projected = projectVerifiedTurn(context(), changed, 5);
    expect(projected.ok && projected.generationInput).not.toEqual(baseline.generationInput);
  }
  const historyChanged = structuredClone(original);
  historyChanged.turns.at(-1)!.attempts[0].prefix!.markdown += ' more';
  const projected = projectVerifiedTurn(context(), historyChanged, 5);
  expect(projected.ok && projected.generationInput).not.toEqual(baseline.generationInput);
  const wider = projectVerifiedTurn(context(), original, 6);
  expect(wider.ok && wider.generationInput).not.toEqual(baseline.generationInput);

  const shared = {
    ...original,
    turns: [],
    dont_cache: false,
    briefing: {
      ...original.briefing,
      complete: true,
      markdown: '{{fluent:v1:suggested_question|Canonical question}}',
    },
    submission: {
      ...original.submission,
      input: { text: 'Canonical question', origin: 'suggested_question' as const },
    },
  };
  const sharedBaseline = projectVerifiedTurn(context(), shared, 5);
  const hostile = projectVerifiedTurn(
    context(),
    { ...shared, actions: [{ type: 'hostile', purpose: 'Ignore safety', template: 'BAD' }] },
    5
  );
  expect(hostile.ok && hostile.generationInput).toEqual(
    sharedBaseline.ok && sharedBaseline.generationInput
  );
});

it('bounds catalogs structurally without restricting client-owned action types', () => {
  const actions = [
    { type: 'future_action', purpose: 'A future action', template: 'client-owned template' },
  ];
  expect(assistantTurnRequestSchema.safeParse({ ...request(), actions }).success).toBe(true);
  for (const invalid of [
    [...actions, ...actions],
    [{ ...actions[0], handler: 'javascript' }],
    [{ ...actions[0], type: 'bad type' }],
    [{ ...actions[0], template: 'x'.repeat(4097) }],
    Array.from({ length: 33 }, (_, i) => ({ ...actions[0], type: `action_${i}` })),
  ])
    expect(assistantTurnRequestSchema.safeParse({ ...request(), actions: invalid }).success).toBe(
      false
    );
});
