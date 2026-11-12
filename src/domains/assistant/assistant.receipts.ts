import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import env from '@/env';

import type { AssistantTurnRequest, TurnContext } from './assistant.turn.types';

import {
  serializeTurnReceiptPayload,
  TURN_LIMITS,
  turnContextSchema,
  turnReceiptPayloadSchema,
} from './assistant.turn.types';

type Payload = ReturnType<typeof turnReceiptPayloadSchema.parse>;
type PrefixBinding = Omit<
  Extract<Payload, { kind: 'prefix' }>,
  | 'protocol'
  | 'keyId'
  | 'actorId'
  | 'contextDigest'
  | 'kind'
  | 'outputDigest'
  | 'sequence'
  | 'complete'
>;

/** One active, dedicated 256-bit key; invalid/missing config disables only continuation. */
export function parseReceiptKey(input: {
  ASSISTANT_RECEIPT_KEY_ID?: string;
  ASSISTANT_RECEIPT_KEY_HEX?: string;
}) {
  const id = input.ASSISTANT_RECEIPT_KEY_ID;
  const hex = input.ASSISTANT_RECEIPT_KEY_HEX;
  return id && /^[\w-]{1,64}$/.test(id) && hex && /^[a-f0-9]{64}$/i.test(hex)
    ? { id, secret: Buffer.from(hex, 'hex') }
    : null;
}

export function loadReceiptKey() {
  return parseReceiptKey(env);
}

// Length framing is unambiguous even for embedded NULs; JSON fields use schema order.
export function integrityDigest(domain: string, value: unknown): string {
  const bytes = Buffer.from(JSON.stringify(value));
  return createHash('sha256')
    .update(`fluent-turn-v1:${domain}:${bytes.length}:`)
    .update(bytes)
    .digest('hex');
}

export class TurnReceipts {
  readonly contextDigest: string;
  constructor(
    private readonly key: NonNullable<ReturnType<typeof parseReceiptKey>>,
    private readonly actorId: number,
    context: TurnContext
  ) {
    this.contextDigest = integrityDigest('context', turnContextSchema.parse(context));
  }

  // Token = base64url(canonical UTF-8 JSON) + dot + base64url(HMAC of the ASCII first part).
  private sign(payload: Payload): string {
    const encoded = Buffer.from(serializeTurnReceiptPayload(payload)).toString('base64url');
    const mac = createHmac('sha256', this.key.secret).update(encoded).digest('base64url');
    return `${encoded}.${mac}`;
  }

  private binding() {
    return {
      protocol: 'fluent-turn-v1' as const,
      keyId: this.key.id,
      actorId: this.actorId,
      contextDigest: this.contextDigest,
    };
  }

  contextReceipt(): string {
    return this.sign({ ...this.binding(), kind: 'context' });
  }

  prefix(
    binding: PrefixBinding,
    prefix: { markdown: string; sequence: number; complete: boolean }
  ): string {
    if (Buffer.byteLength(prefix.markdown) > TURN_LIMITS.outputBytes)
      throw new Error('Continuation output exceeds limit');
    return this.sign({
      ...this.binding(),
      kind: 'prefix',
      ...binding,
      outputDigest: integrityDigest('output', prefix.markdown),
      sequence: prefix.sequence,
      complete: prefix.complete,
    });
  }

  verify(token: string): Payload | null {
    if (token.length > TURN_LIMITS.receiptChars || !/^[\w-]+\.[\w-]{43}$/.test(token)) return null;
    const [encoded, mac] = token.split('.');
    const expected = createHmac('sha256', this.key.secret).update(encoded).digest();
    const received = Buffer.from(mac, 'base64url');
    if (received.length !== expected.length || !timingSafeEqual(expected, received)) return null;
    try {
      const bytes = Buffer.from(encoded, 'base64url');
      if (bytes.toString('base64url') !== encoded || received.toString('base64url') !== mac)
        return null;
      const parsed = turnReceiptPayloadSchema.safeParse(JSON.parse(bytes.toString('utf8')));
      if (!parsed.success || serializeTurnReceiptPayload(parsed.data) !== bytes.toString('utf8'))
        return null;
      const value = parsed.data;
      return value.keyId === this.key.id &&
        value.actorId === this.actorId &&
        value.contextDigest === this.contextDigest
        ? value
        : null;
    } catch {
      return null;
    }
  }

  verifyPrefix(prefix: AssistantTurnRequest['briefing'], binding: PrefixBinding): boolean {
    const value = this.verify(prefix.receipt);
    return (
      value?.kind === 'prefix' &&
      value.operation === binding.operation &&
      value.parentDigest === binding.parentDigest &&
      value.inputDigest === binding.inputDigest &&
      value.projectionDigest === binding.projectionDigest &&
      value.outputDigest === integrityDigest('output', prefix.markdown) &&
      value.sequence === prefix.sequence &&
      value.complete === prefix.complete
    );
  }

  briefingBinding(
    generationFingerprint = integrityDigest('briefing-projection', this.contextDigest)
  ): PrefixBinding {
    return {
      operation: 'briefing',
      parentDigest: integrityDigest('briefing-parent', this.contextDigest),
      inputDigest: integrityDigest('briefing-input', null),
      projectionDigest: generationFingerprint,
    };
  }
}

export function visibleBranch(
  parent: string,
  input: AssistantTurnRequest['submission']['input'] | null,
  prefix: AssistantTurnRequest['briefing'] | null
): string {
  return integrityDigest('visible-branch', {
    parent,
    input: input ? { text: input.text, origin: input.origin } : null,
    output: prefix ? { markdown: prefix.markdown, complete: prefix.complete } : null,
  });
}
