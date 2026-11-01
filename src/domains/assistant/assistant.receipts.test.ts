import { Buffer } from 'node:buffer';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { AssistantTurnRequest } from './assistant.turn.types';

import { integrityDigest, parseReceiptKey, TurnReceipts } from './assistant.receipts';
import { verifyTurnTranscript } from './assistant.transcript';
import { assistantTurnRequestSchema, turnContextSchema } from './assistant.turn.types';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/turn-v1.json', import.meta.url), 'utf8')
);
const golden = JSON.parse(
  readFileSync(new URL('./fixtures/receipt-v1.json', import.meta.url), 'utf8')
);
const context = turnContextSchema.parse(fixture.context);
const key = parseReceiptKey({
  ASSISTANT_RECEIPT_KEY_ID: 'test-key',
  ASSISTANT_RECEIPT_KEY_HEX: '00'.repeat(32),
})!;
const receipts = new TurnReceipts(key, 17, context);
function request() {
  const value = assistantTurnRequestSchema.parse(fixture.request);
  value.contextReceipt = receipts.contextReceipt();
  value.briefing.receipt = receipts.prefix(receipts.briefingBinding(), value.briefing);
  return value;
}
function append(value: AssistantTurnRequest, markdown: string | null = 'Answer', complete = true) {
  const verified = verifyTurnTranscript(receipts, context, value, 2);
  if (!verified.ok) throw new Error(verified.code);
  const prefix = markdown === null ? null : { markdown, complete, sequence: 1, receipt: '' };
  if (prefix) prefix.receipt = receipts.prefix(verified.binding, prefix);
  const attempt = {
    attemptId: value.submission.attemptId,
    operationId: `op-${value.submission.attemptId}`,
    state: complete ? ('complete' as const) : ('interrupted' as const),
    prefix,
  };
  if (value.submission.kind === 'retry') {
    const last = value.turns.at(-1)!;
    last.attempts.push(attempt);
    last.selectedAttemptId = attempt.attemptId;
  } else
    value.turns.push({
      turnId: value.submission.turnId,
      input: value.submission.input,
      selectedAttemptId: attempt.attemptId,
      attempts: [attempt],
    });
  value.submission = {
    kind: 'new',
    turnId: `turn-${value.turns.length + 1}`,
    attemptId: `attempt-${value.turns.length + 1}`,
    input: { text: `Question ${value.turns.length + 1}`, origin: 'typed' },
  };
  return value;
}

describe('canonical HMAC receipt framing', () => {
  it('matches independently generated portable context and Unicode prefix golden vectors', () => {
    expect(receipts.contextDigest).toBe(golden.contextDigest);
    expect(receipts.contextReceipt()).toBe(golden.contextToken);
    expect(receipts.prefix(receipts.briefingBinding(), golden.prefix)).toBe(golden.prefixToken);
    expect(receipts.verify(golden.prefixToken)).toEqual(golden.prefixPayload);
    expect(integrityDigest('input', 'x')).not.toBe(integrityDigest('output', 'x'));
  });
  it('requires explicit dedicated valid key configuration', () => {
    expect(parseReceiptKey({})).toBeNull();
    for (const hex of ['secret', '00'.repeat(31), 'gg'.repeat(32), '00'.repeat(33)])
      expect(
        parseReceiptKey({ ASSISTANT_RECEIPT_KEY_ID: 'key', ASSISTANT_RECEIPT_KEY_HEX: hex })
      ).toBeNull();
    expect(
      parseReceiptKey({
        ASSISTANT_RECEIPT_KEY_ID: 'bad.id',
        ASSISTANT_RECEIPT_KEY_HEX: golden.keyHex,
      })
    ).toBeNull();
    expect(verifyTurnTranscript(null, context, request(), 2)).toEqual({
      ok: false,
      code: 'temporarily_unavailable',
    });
  });
  it('rejects forged, oversized, noncanonical, unknown-version and rotated-key tokens', () => {
    const signed = (payload: unknown) => {
      const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${encoded}.${createHmac('sha256', key.secret).update(encoded).digest('base64url')}`;
    };
    for (const token of [
      'a'.repeat(4097),
      `${golden.contextToken}a`,
      golden.contextToken.replace(/^./, 'A'),
      signed({ ...golden.prefixPayload, protocol: 'fluent-turn-v2' }),
      signed({ ...golden.prefixPayload, keyId: 'unknown' }),
      signed({ ...golden.prefixPayload, extra: true }),
      signed(Object.fromEntries(Object.entries(golden.prefixPayload).reverse())),
    ])
      expect(receipts.verify(token)).toBeNull();
    expect(
      new TurnReceipts({ ...key, id: 'next' }, 17, context).verify(golden.contextToken)
    ).toBeNull();
    expect(
      new TurnReceipts({ ...key, secret: Buffer.alloc(32, 1) }, 17, context).verify(
        golden.contextToken
      )
    ).toBeNull();
  });
});

describe('full bounded transcript verification', () => {
  it('authenticates actor, source, language, project, policy, resource and current context', () => {
    const value = append(request());
    for (const changed of [
      { projectId: 2 },
      { outputLanguage: 'hi' },
      { sourceBible: 'Other' },
      { sourceRevision: 'next' },
      { resourceRevision: 'next' },
      { profileVersion: 'next' },
      { resourcePolicyVersion: 'next' },
      { epoch: 'next' },
      { authorizationScope: 'b'.repeat(64) },
      { verses: [{ ...context.verses[0], text: 'tampered source' }] },
    ]) {
      const current = { ...context, ...changed };
      expect(verifyTurnTranscript(new TurnReceipts(key, 17, current), current, value, 2)).toEqual({
        ok: false,
        code: 'context_changed',
      });
    }
    expect(verifyTurnTranscript(new TurnReceipts(key, 18, context), context, value, 2)).toEqual({
      ok: false,
      code: 'context_changed',
    });
    expect(verifyTurnTranscript(receipts, { ...context, epoch: 'next' }, value, 2)).toEqual({
      ok: false,
      code: 'context_changed',
    });
  });
  it('rejects exact output, completion, sequence and input tampering', () => {
    for (const mutate of [
      (v: AssistantTurnRequest) => {
        v.turns[0].input.text += ' ';
      },
      (v: AssistantTurnRequest) => {
        v.turns[0].input.origin = 'suggested_question';
      },
      (v: AssistantTurnRequest) => {
        v.turns[0].attempts[0].prefix!.markdown += ' ';
      },
      (v: AssistantTurnRequest) => {
        v.turns[0].attempts[0].prefix!.sequence++;
      },
      (v: AssistantTurnRequest) => {
        v.turns[0].attempts[0].prefix!.complete = false;
        v.turns[0].attempts[0].state = 'failed';
      },
      (v: AssistantTurnRequest) => {
        v.briefing.markdown += ' ';
      },
    ]) {
      const value = append(request());
      mutate(value);
      expect(verifyTurnTranscript(receipts, context, value, 2)).toEqual({
        ok: false,
        code: 'context_changed',
      });
    }
  });
  it('verifies omitted older exchanges before history-window reduction and rejects reorder/middle omission/splice', () => {
    const value = request();
    for (let i = 0; i < 5; i++) append(value);
    const good = verifyTurnTranscript(receipts, context, value, 2);
    expect(good.ok && good.projection.projection.omittedTurnIds).toHaveLength(3);
    for (const mutate of [
      (v: AssistantTurnRequest) => {
        v.turns[0].attempts[0].prefix!.markdown += 'tamper';
      },
      (v: AssistantTurnRequest) => {
        [v.turns[0], v.turns[1]] = [v.turns[1], v.turns[0]];
      },
      (v: AssistantTurnRequest) => {
        v.turns.splice(1, 1);
      },
      (v: AssistantTurnRequest) => {
        v.turns[2].attempts[0].prefix = v.turns[1].attempts[0].prefix;
      },
    ]) {
      const copy = structuredClone(value);
      mutate(copy);
      expect(verifyTurnTranscript(receipts, context, copy, 2)).toEqual({
        ok: false,
        code: 'context_changed',
      });
    }
  });
  it('allows early frozen briefing, retry replacement and later input without failed suffix as parent', () => {
    const value = request();
    value.briefing.complete = false;
    value.briefing.receipt = receipts.prefix(receipts.briefingBinding(), value.briefing);
    append(value, 'partial', false);
    value.submission = {
      kind: 'retry',
      turnId: value.turns[0].turnId,
      attemptId: 'replacement',
      input: value.turns[0].input,
    };
    const retry = verifyTurnTranscript(receipts, context, value, 2);
    expect(retry.ok && retry.projection.history).toEqual([]);
    append(value, 'replacement complete');
    append(value, 'later answer');
    append(value, 'third answer');
    append(value, 'fourth answer');
    expect(verifyTurnTranscript(receipts, context, value, 2).ok).toBe(true);
    value.turns[0].attempts[0].prefix!.markdown = 'tampered nonselected attempt';
    expect(verifyTurnTranscript(receipts, context, value, 2)).toEqual({
      ok: false,
      code: 'context_changed',
    });
  });
  it('binds empty failed inputs and deliberate new-input partial branches', () => {
    for (const output of [null, '', 'partial']) {
      const value = append(request(), output, false);
      const before = verifyTurnTranscript(receipts, context, value, 2);
      expect(before.ok && before.projection.history.length).toBe(output ? 1 : 0);
      append(value);
      expect(verifyTurnTranscript(receipts, context, value, 2).ok).toBe(true);
      value.turns.splice(0, 1);
      expect(verifyTurnTranscript(receipts, context, value, 2)).toEqual({
        ok: false,
        code: 'context_changed',
      });
    }
  });
  it('supports repeated retries after empty/partial failure and binds their replacement parent', () => {
    for (const firstOutput of [null, '', 'partial']) {
      const value = append(request(), firstOutput, false);
      for (let index = 1; index < 4; index++) {
        value.submission = {
          kind: 'retry',
          turnId: value.turns[0].turnId,
          attemptId: `retry-${index}`,
          input: value.turns[0].input,
        };
        append(value, index === 3 ? 'completed replacement' : 'still partial', index === 3);
      }
      append(value, 'child');
      expect(verifyTurnTranscript(receipts, context, value, 2).ok).toBe(true);
      value.turns[0].selectedAttemptId = value.turns[0].attempts[0].attemptId;
      expect(verifyTurnTranscript(receipts, context, value, 2)).toEqual({
        ok: false,
        code: 'context_changed',
      });
    }
  });
  it('detects mutation of empty-turn input once a signed child binds it', () => {
    const value = append(request(), null, false);
    append(value);
    value.turns[0].input.text = 'other empty input';
    expect(verifyTurnTranscript(receipts, context, value, 2)).toEqual({
      ok: false,
      code: 'context_changed',
    });
  });
  it('canonicalizes context key order and excludes delivery ids from semantic lineage', () => {
    const value = append(request());
    const before = verifyTurnTranscript(receipts, context, value, 2);
    value.turns[0].turnId = 'renamed';
    value.turns[0].attempts[0].attemptId = 'renamed-attempt';
    value.turns[0].attempts[0].operationId = 'renamed-operation';
    value.turns[0].selectedAttemptId = 'renamed-attempt';
    const reordered = turnContextSchema.parse(
      Object.fromEntries(Object.entries(context).reverse())
    );
    const after = verifyTurnTranscript(receipts, reordered, value, 2);
    expect(before.ok && after.ok && before.binding).toEqual(after.ok && after.binding);
  });
  it('bounds transcript admission before verification and rejects different semantic projection', () => {
    expect(verifyTurnTranscript(receipts, context, { ...request(), extra: true }, 2)).toEqual({
      ok: false,
      code: 'invalid_request',
    });
    const value = request();
    for (let i = 0; i < 4; i++) append(value);
    expect(verifyTurnTranscript(receipts, context, value, 1)).toEqual({
      ok: false,
      code: 'context_changed',
    });
  });
});
