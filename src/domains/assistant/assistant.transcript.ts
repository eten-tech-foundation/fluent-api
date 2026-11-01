import type { TurnReceipts } from './assistant.receipts';
import type { TurnContext } from './assistant.turn.types';

import { integrityDigest, visibleBranch } from './assistant.receipts';
import { projectVerifiedTurn } from './assistant.turn.prompt';
import { assistantTurnRequestSchema, turnContextSchema } from './assistant.turn.types';

function projectionDigest(
  projection: Extract<ReturnType<typeof projectVerifiedTurn>, { ok: true }>
) {
  return integrityDigest('projection', {
    message: projection.message,
    history: projection.history,
    responseLanguageHint: projection.responseLanguageHint,
  });
}

/** Call only after the route guards and fresh canonical resolution. No cache-row dependency.
 * Phase C must enforce raw body admission before parsing, and use the returned projection
 * and binding for generation/cache identity/signing, never a browser-provided projection.
 */
export function verifyTurnTranscript(
  receipts: TurnReceipts | null,
  context: TurnContext,
  body: unknown,
  historyWindow: number
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
  if (
    receipts.verify(request.contextReceipt)?.kind !== 'context' ||
    !receipts.verifyPrefix(request.briefing, receipts.briefingBinding())
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
  // Verify exact semantic projections only after the full chain and output MACs passed.
  for (const [index, turn] of request.turns.entries()) {
    const historical = projectVerifiedTurn(
      context,
      {
        ...request,
        turns: request.turns.slice(0, index),
        submission: {
          kind: 'new',
          turnId: turn.turnId,
          attemptId: turn.selectedAttemptId,
          input: turn.input,
        },
      },
      historyWindow
    );
    if (!historical.ok) return historical;
    const digest = projectionDigest(historical);
    for (const attempt of turn.attempts) {
      if (!attempt.prefix) continue;
      const payload = receipts.verify(attempt.prefix.receipt);
      if (payload?.kind !== 'prefix' || payload.projectionDigest !== digest) return changed;
    }
  }
  const projection = projectVerifiedTurn(context, request, historyWindow);
  if (!projection.ok) return projection;
  return {
    ok: true,
    request,
    projection,
    binding: {
      operation: 'turn' as const,
      parentDigest: request.submission.kind === 'retry' ? parents.at(-1)! : parent,
      inputDigest: integrityDigest('input', request.submission.input),
      projectionDigest: projectionDigest(projection),
    },
  } as const;
}
