import type { TurnReceipts } from './assistant.receipts';
import type { TurnContext } from './assistant.turn.types';

import { generationInputFingerprint } from './assistant.generation-input';
import { integrityDigest, visibleBranch } from './assistant.receipts';
import { isSharedTurnEligible, projectVerifiedTurn } from './assistant.turn.prompt';
import { assistantTurnRequestSchema, TURN_LIMITS, turnContextSchema } from './assistant.turn.types';

function projectionDigest(
  projection: Extract<ReturnType<typeof projectVerifiedTurn>, { ok: true }>
) {
  return generationInputFingerprint(projection.generationInput);
}

/** Call only after the route guards and fresh canonical resolution. No cache-row dependency.
 * Routes enforce raw body admission before parsing, and use the returned projection
 * and binding for generation/cache identity/signing, never a browser-provided projection.
 */
export function verifyTurnTranscript(
  receipts: TurnReceipts | null,
  context: TurnContext,
  body: unknown,
  historyWindow: number,
  compatibility?: {
    cacheEpoch: string;
    maxOutputBytes: number;
    canonicalBriefingFingerprint: string;
  }
) {
  if (!receipts) return { ok: false, code: 'temporarily_unavailable' } as const;
  const parsed = assistantTurnRequestSchema.safeParse(body);
  if (!parsed.success) return { ok: false, code: 'invalid_request' } as const;
  const request = parsed.data;
  const changed = { ok: false, code: 'context_changed' } as const;
  const canonical = turnContextSchema.safeParse(context);
  if (!canonical.success) return { ok: false, code: 'context_too_large' } as const;
  if (
    receipts.contextDigest !== integrityDigest('context', canonical.data) ||
    request.outputLanguage !== context.outputLanguage ||
    !context.verses.some(
      (verse) =>
        verse.bookCode === request.bookCode.toUpperCase() &&
        verse.chapter === request.chapter &&
        verse.verse === request.activeVerse
    )
  )
    return changed;
  const briefingPayload = receipts.verify(request.briefing.receipt);
  if (briefingPayload?.kind !== 'prefix') return changed;
  const resolvedCompatibility = compatibility ?? {
    cacheEpoch: context.epoch,
    maxOutputBytes: TURN_LIMITS.outputBytes,
    canonicalBriefingFingerprint: briefingPayload.projectionDigest,
  };
  const sharedBriefing =
    briefingPayload.projectionDigest === resolvedCompatibility.canonicalBriefingFingerprint;
  if (
    receipts.verify(request.contextReceipt)?.kind !== 'context' ||
    !receipts.verifyPrefix(
      request.briefing,
      receipts.briefingBinding(briefingPayload.projectionDigest)
    )
  )
    return changed;
  let parent = visibleBranch(receipts.contextDigest, null, request.briefing);
  const parents: string[] = [];
  // Authenticate every retained attempt, including those outside the provider window,
  // before constructing any reduced history. Retry alternatives share a logical parent.
  for (const turn of request.turns) {
    parents.push(parent);
    const inputDigest = integrityDigest('input', turn.input);
    for (const attempt of turn.attempts) {
      if (!attempt.prefix) continue;
      const payload = receipts.verify(attempt.prefix.receipt);
      if (
        payload?.kind !== 'prefix' ||
        !receipts.verifyPrefix(attempt.prefix, {
          operation: 'turn',
          parentDigest: parent,
          inputDigest,
          projectionDigest: payload.projectionDigest,
        })
      )
        return changed;
    }
    const selected = turn.attempts.find((attempt) => attempt.attemptId === turn.selectedAttemptId)!;
    parent = visibleBranch(parent, turn.input, selected.prefix);
  }
  // Each historical answer remains bound to the exact provider input that produced it. The
  // signed digest must match either its server-canonical shared form or its bounded private form.
  for (const [index, turn] of request.turns.entries()) {
    const historicalRequest = {
      ...request,
      turns: request.turns.slice(0, index),
      submission: {
        kind: 'new' as const,
        turnId: turn.turnId,
        attemptId: turn.selectedAttemptId,
        input: turn.input,
      },
    };
    const candidates = [true, false].flatMap((dontCache) => {
      const historical = projectVerifiedTurn(
        context,
        { ...historicalRequest, dont_cache: dontCache },
        historyWindow,
        { ...resolvedCompatibility, sharedBriefing }
      );
      return historical.ok ? [projectionDigest(historical)] : [];
    });
    for (const attempt of turn.attempts) {
      if (!attempt.prefix) continue;
      const payload = receipts.verify(attempt.prefix.receipt);
      if (payload?.kind !== 'prefix' || !candidates.includes(payload.projectionDigest))
        return changed;
    }
  }
  const projection = projectVerifiedTurn(context, request, historyWindow, {
    ...resolvedCompatibility,
    sharedBriefing,
  });
  if (!projection.ok) return projection;
  const canonicalRequest = { ...request, dont_cache: false };
  const cachedProjection = isSharedTurnEligible(canonicalRequest, sharedBriefing)
    ? projectVerifiedTurn(context, canonicalRequest, historyWindow, {
        ...resolvedCompatibility,
        sharedBriefing,
      })
    : null;
  return {
    ok: true,
    request,
    projection,
    cachedProjection: cachedProjection?.ok ? cachedProjection : null,
    sharedBriefing,
    binding: {
      operation: 'turn' as const,
      parentDigest: request.submission.kind === 'retry' ? parents.at(-1)! : parent,
      inputDigest: integrityDigest('input', request.submission.input),
      projectionDigest: projectionDigest(projection),
    },
  } as const;
}
