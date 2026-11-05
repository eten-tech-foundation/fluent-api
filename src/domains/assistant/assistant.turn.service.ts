import { Buffer } from 'node:buffer';

import type { Result } from '@/lib/types';

import env from '@/env';
import { ok } from '@/lib/types';

import type { BriefingEvent } from './assistant.client';
import type { AssistantServiceError } from './assistant.types';

import {
  beginBriefingCacheLookup,
  findInFlightBriefing,
  installOrJoinBriefing,
  removeInFlightBriefing,
} from './assistant.cache';
import { BtServantClient } from './assistant.client';
import {
  assistantLanguageConfigurationFailure,
  loadAssistantConfig,
  resolveGrounding,
} from './assistant.config';
import { resolveTurnContext } from './assistant.context';
import { btUserId } from './assistant.prompt';
import { integrityDigest, loadReceiptKey, TurnReceipts } from './assistant.receipts';
import * as repo from './assistant.repository';
import { verifyTurnTranscript } from './assistant.transcript';
import { boundedTurnEvents, deliverTurn } from './assistant.turn.delivery';
import {
  assistantTurnRequestSchema,
  historyWindowSchema,
  TURN_LIMITS,
  TURN_PROTOCOL,
} from './assistant.turn.types';
import { assistantFailure } from './assistant.types';
import * as cacheRepo from './cache/assistant-cache.repository';

interface TurnInput {
  projectId: number;
  userId: number;
  body: unknown;
  signal: AbortSignal;
  logger: { warn: (data: unknown, message: string) => void };
}

export async function createPassageTurn(
  input: TurnInput
): Promise<Result<{ events: ReturnType<typeof deliverTurn> }, AssistantServiceError>> {
  const fail = assistantFailure;
  const parsed = assistantTurnRequestSchema.safeParse(input.body);
  if (!parsed.success) return fail('invalid_request');
  const config = loadAssistantConfig();
  if (!config)
    return fail(assistantLanguageConfigurationFailure()?.code ?? 'temporarily_unavailable');
  const key = loadReceiptKey();
  // Five pairs was measured on staging; operators must match deployment configuration.
  const windowSetting = env.ASSISTANT_HISTORY_WINDOW ?? '5';
  const historyWindow = /^\d+$/.test(windowSetting) ? Number(windowSetting) : Number.NaN;
  if (!key || !historyWindowSchema.safeParse(historyWindow).success)
    return fail('temporarily_unavailable');
  const request = parsed.data;
  if (!Object.hasOwn(config.languages, request.outputLanguage)) return fail('unsupported_language');
  const grounding = resolveGrounding(config.languages[request.outputLanguage], request.grounding);
  if (!grounding) return fail('unsupported_language');
  let passage;
  try {
    passage = await repo.resolveCanonicalPassage({
      projectId: input.projectId,
      bookCode: request.bookCode,
      chapter: request.chapter,
      activeVerse: request.activeVerse,
    });
  } catch {
    return fail('temporarily_unavailable');
  }
  if (!passage) return fail('context_changed');
  const context = resolveTurnContext({
    projectId: input.projectId,
    passage,
    config,
    outputLanguage: request.outputLanguage,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
  });
  if (!context) return fail('context_too_large');
  const receipts = new TurnReceipts(key, input.userId, context);
  const verified = verifyTurnTranscript(receipts, context, request, historyWindow);
  if (!verified.ok) return fail(verified.code);
  if (Buffer.byteLength(verified.projection.message) > config.budgets.maxInputBytes)
    return fail('context_too_large');
  const budgets = {
    ...config.budgets,
    maxFrameBytes: Math.min(config.budgets.maxFrameBytes, TURN_LIMITS.frameBytes),
    connectMs: Math.min(config.budgets.connectMs, TURN_LIMITS.connectMs),
    idleMs: Math.min(config.budgets.idleMs, TURN_LIMITS.idleMs),
    totalMs: Math.min(config.budgets.totalMs, TURN_LIMITS.totalMs),
    maxOutputBytes: Math.min(config.budgets.maxOutputBytes, TURN_LIMITS.outputBytes),
  };
  const projection = verified.projection;
  const cacheKey = integrityDigest('completed-turn-artifact-v1', {
    context,
    budgets,
    maxOutputChars: TURN_LIMITS.outputChars,
    historyWindow,
    protocol: TURN_PROTOCOL,
    message: projection.message,
    history: projection.history,
    responseLanguageHint: projection.responseLanguageHint,
  });
  // Reuse retained normalized transport mechanics, with a distinct turn namespace.
  const producerKey = `turn-v1:${cacheKey}`;
  const operationId = crypto.randomUUID();
  const warn = () => input.logger.warn({ operationId }, 'Assistant turn cache unavailable');
  const source = (signal: AbortSignal) =>
    boundedTurnEvents(
      new BtServantClient({
        baseUrl: config.baseUrl,
        engineKey: config.engineKey,
        org: config.org,
        ...budgets,
      }).stream(
        {
          userId: btUserId(input.userId),
          message: projection.message,
          history: projection.history,
          responseLanguageHint: projection.responseLanguageHint,
        },
        signal
      )
    );
  const deliver = (events: AsyncIterable<BriefingEvent>) =>
    ok({
      events: deliverTurn(events, receipts, verified, operationId, input.signal),
    });
  let producer = request.dont_cache ? undefined : findInFlightBriefing(producerKey);
  let completed: Awaited<ReturnType<typeof cacheRepo.findCompletedTurn>> = null;
  let installed = false;
  if (!producer) {
    const release = request.dont_cache ? () => {} : beginBriefingCacheLookup(producerKey);
    try {
      completed = await cacheRepo.findCompletedTurn(cacheKey, input.signal);
      if (
        completed &&
        (!completed.markdown.trim() ||
          completed.outputContractVersion !== TURN_PROTOCOL ||
          completed.markdown.length > TURN_LIMITS.outputChars ||
          Buffer.byteLength(completed.markdown) > budgets.maxOutputBytes)
      ) {
        warn();
        completed = null;
      }
    } catch {
      warn();
    } finally {
      if (!completed && !request.dont_cache && !input.signal.aborted) {
        const result = installOrJoinBriefing(producerKey);
        producer = result.producer;
        installed = result.installed;
      }
      release();
    }
  }
  cacheRepo.requestExpiredTurnCleanup(warn);
  if (completed) {
    const markdown = completed.markdown;
    return deliver(
      (async function* () {
        if (markdown) yield { type: 'briefing_delta', delta: markdown } as const;
        yield { type: 'briefing_complete', markdown } as const;
      })()
    );
  }
  if (request.dont_cache || !producer) return deliver(source(input.signal));
  const retained = producer;
  if (installed) {
    const production = (async () => {
      try {
        for await (const event of source(retained.upstreamSignal)) {
          if (event.type === 'briefing_complete') {
            retained.beginCompletionWrite();
            try {
              await cacheRepo.publishCompletedTurn(
                cacheKey,
                event.markdown,
                TURN_PROTOCOL,
                retained.upstreamSignal
              );
            } catch {
              warn();
            }
            retained.finishCompletionWrite(event);
            return;
          }
          if (!retained.publish(event) || event.type === 'briefing_error') return;
        }
      } finally {
        removeInFlightBriefing(producerKey, retained);
      }
    })();
    retained.attachProduction(production);
  }
  return deliver(retained.subscribe(input.signal));
}
