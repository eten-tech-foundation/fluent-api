import { z } from '@hono/zod-openapi';

import { assistantActionsSchema, assistantErrorSchema } from './assistant.types';
import { ASSISTANT_SAFETY_LIMITS } from './lib/output';

export const historyWindowSchema = z.number().int().min(1).max(50);

export const TURN_PROTOCOL = 'fluent-turn-v1';
export const TURN_LIMITS = {
  bodyBytes: 524_288,
  transcriptBytes: 393_216,
  turns: 50,
  attemptsPerTurn: 4,
  inputChars: 4_000,
  inputBytes: 16_000,
  outputBytes: ASSISTANT_SAFETY_LIMITS.maximumAnswerBytes,
  receiptChars: 4_096,
  sourceBytes: 32_000,
  messageBytes: 48_000,
  historyFieldChars: 16_000,
  historyBytes: 524_288,
  frameBytes: 1_048_576,
  connectMs: 10_000,
  idleMs: 45_000,
  totalMs: 180_000,
} as const;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const text = (chars: number, maxBytes: number) =>
  z
    .string()
    .max(chars)
    .refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes);
const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/);
const revision = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receipt = z
  .string()
  .min(1)
  .max(TURN_LIMITS.receiptChars)
  .regex(/^[\w.-]+$/);
const markdown = z
  .string()
  .refine((value) => new TextEncoder().encode(value).byteLength <= TURN_LIMITS.outputBytes);
const input = z
  .object({
    text: text(TURN_LIMITS.inputChars, TURN_LIMITS.inputBytes).refine(
      (value) => value.trim().length > 0
    ),
    origin: z.enum(['typed', 'suggested_question']),
  })
  .strict();
const prefix = z.object({ markdown, sequence: integer, complete: z.boolean(), receipt }).strict();
const attempt = z
  .object({
    attemptId: id,
    operationId: id,
    state: z.enum(['complete', 'failed', 'interrupted']),
    prefix: prefix.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.state === 'complete') !== (value.prefix?.complete === true))
      ctx.addIssue({ code: 'custom', message: 'Completion state must match the committed prefix' });
  });
const turn = z
  .object({
    turnId: id,
    input,
    selectedAttemptId: id,
    attempts: z.array(attempt).min(1).max(TURN_LIMITS.attemptsPerTurn),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.attempts.map((entry) => entry.attemptId);
    if (new Set(ids).size !== ids.length || !ids.includes(value.selectedAttemptId))
      ctx.addIssue({ code: 'custom', message: 'Invalid selected or duplicate attempt' });
  });

export const assistantTurnRequestSchema = z
  .object({
    protocol: z.literal(TURN_PROTOCOL),
    bookCode: z.string().min(3).max(50),
    chapter: integer.min(1),
    activeVerse: integer.min(1),
    outputLanguage: z.string().min(1).max(20),
    grounding: z.enum(['configured', 'output_language', 'english']),
    contextReceipt: receipt,
    briefing: prefix,
    turns: z.array(turn).max(TURN_LIMITS.turns),
    submission: z
      .object({
        kind: z.enum(['new', 'retry']),
        turnId: id,
        attemptId: id,
        input,
      })
      .strict(),
    dont_cache: z.boolean().default(true),
    actions: assistantActionsSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.turns.map((entry) => entry.turnId);
    const last = value.turns.at(-1);
    const submission = value.submission;
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate turn' });
    if (
      submission.kind === 'new' &&
      (ids.includes(submission.turnId) || ids.length >= TURN_LIMITS.turns)
    )
      ctx.addIssue({ code: 'custom', message: 'New turn must have room and a new id' });
    if (
      submission.kind === 'retry' &&
      (!last ||
        last.turnId !== submission.turnId ||
        JSON.stringify(last.input) !== JSON.stringify(submission.input) ||
        last.attempts.length >= TURN_LIMITS.attemptsPerTurn ||
        last.attempts.find((entry) => entry.attemptId === last.selectedAttemptId)?.state ===
          'complete')
    )
      ctx.addIssue({ code: 'custom', message: 'Retry must replace the latest unfinished turn' });
    const attemptIds = value.turns.flatMap((entry) => entry.attempts.map((item) => item.attemptId));
    if (new Set(attemptIds).size !== attemptIds.length || attemptIds.includes(submission.attemptId))
      ctx.addIssue({ code: 'custom', message: 'Attempt ids must be unique' });
    if (bytes(value.turns) > TURN_LIMITS.transcriptBytes || bytes(value) > TURN_LIMITS.bodyBytes)
      ctx.addIssue({ code: 'custom', message: 'Transcript or request exceeds byte budget' });
  });
export type AssistantTurnRequest = z.infer<typeof assistantTurnRequestSchema>;

// Server-resolved only. Never populate this from browser selectors or receipt claims.
export const turnContextSchema = z
  .object({
    projectId: integer.min(1),
    sourceBible: z.string().min(1).max(128),
    sourceLanguageCode: z.string().min(1).max(20),
    verses: z
      .array(
        z
          .object({
            bookCode: z.string().min(3).max(50),
            chapter: integer.min(1),
            verse: integer.min(1),
            text: text(TURN_LIMITS.sourceBytes, TURN_LIMITS.sourceBytes),
          })
          .strict()
      )
      .min(1)
      .max(200),
    outputLanguage: z.string().min(1).max(20),
    responseLanguageHint: z.string().regex(/^[a-z]{2}$/),
    guidanceSlug: z.string().regex(/^[a-z][\w-]{0,19}$/i),
    resourceLanguage: z.string().min(1).max(20),
    groundingInstruction: z.string().max(500),
    authorizationScope: digest,
    sourceRevision: revision,
    resourceRevision: revision,
    operationVersion: z.literal('passage-turn-v1'),
    profileVersion: revision,
    resourcePolicyVersion: revision,
    epoch: revision,
  })
  .strict()
  .refine((value) => bytes(value.verses) <= TURN_LIMITS.sourceBytes);
export type TurnContext = z.infer<typeof turnContextSchema>;

// Canonical signing bytes are UTF-8 JSON.stringify(schema.parse(payload)); schema field
// order is protocol order. No optional keys, timestamps, cache ids, or execution ids.
const binding = {
  protocol: z.literal(TURN_PROTOCOL),
  keyId: id,
  actorId: integer.min(1),
  contextDigest: digest,
};
export const turnReceiptPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ ...binding, kind: z.literal('context') }).strict(),
  z
    .object({
      ...binding,
      kind: z.literal('prefix'),
      operation: z.enum(['briefing', 'turn']),
      parentDigest: digest,
      inputDigest: digest,
      projectionDigest: digest,
      outputDigest: digest,
      sequence: integer,
      complete: z.boolean(),
    })
    .strict(),
]);
type TurnReceiptPayload = z.infer<typeof turnReceiptPayloadSchema>;

export function serializeTurnReceiptPayload(payload: TurnReceiptPayload): string {
  return JSON.stringify(turnReceiptPayloadSchema.parse(payload));
}

const eventBinding = {
  protocol: z.literal(TURN_PROTOCOL),
  operationId: id,
  turnId: id,
  attemptId: id,
};
const omissions = z
  .object({
    omittedTurnIds: z.array(id).max(TURN_LIMITS.turns),
    emptyTurnIds: z.array(id).max(TURN_LIMITS.turns),
    historyWindow: historyWindowSchema,
  })
  .strict();
export const assistantTurnEventSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...eventBinding,
      type: z.literal('turn_started'),
      outputContractVersion: z.literal('fluent-widgets-v1').optional(),
      contextReceipt: receipt,
      projection: omissions,
    })
    .strict(),
  z
    .object({
      ...eventBinding,
      type: z.literal('turn_delta'),
      delta: markdown,
      sequence: integer,
      receipt,
    })
    .strict(),
  z
    .object({
      ...eventBinding,
      type: z.literal('turn_replace'),
      markdown,
      sequence: integer,
      receipt,
    })
    .strict(),
  z
    .object({ ...eventBinding, type: z.literal('turn_complete'), sequence: integer, receipt })
    .strict(),
  z
    .object({
      ...eventBinding,
      type: z.literal('turn_error'),
      ...assistantErrorSchema.shape,
    })
    .strict(),
  z.object({ protocol: z.literal(TURN_PROTOCOL), type: z.literal('context_changed') }).strict(),
]);

// Add alongside existing briefing_started/delta/complete fields. A delivery with no
// signing configuration or oversized context/output instead sets continuationUnavailable.
// Never use a previously signed prefix with later unsigned text.
export const briefingIntegrityMetadataSchema = z
  .object({
    protocol: z.literal(TURN_PROTOCOL),
    contextReceipt: receipt,
    operationId: id,
    prefix: z.object({ sequence: integer, complete: z.boolean(), receipt }).strict().optional(),
  })
  .strict();
