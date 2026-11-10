import { Buffer } from 'node:buffer';

import type { Result } from '@/lib/types';

import env from '@/env';
import { ok } from '@/lib/types';

import type { BriefingEvent } from './assistant.client';
import type { AssistantServiceError } from './assistant.types';

import {
  beginGenerationCacheLookup,
  findInFlightGeneration,
  installOrJoinGeneration,
  removeInFlightGeneration,
} from './assistant.cache';
import {
  assistantLanguageConfigurationFailure,
  loadAssistantConfig,
  resolveGrounding,
} from './assistant.config';
import { resolveTurnContext } from './assistant.context';
import {
  acquireGeneration,
  createAssistantClient,
  releasePrivateGeneration,
} from './assistant.generation';
import {
  createBriefingGenerationInput,
  generationInputFingerprint,
  providerRequest,
} from './assistant.generation-input';
import { btUserId, SHARED_ASSISTANT_ACTIONS, WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import { loadReceiptKey, TurnReceipts } from './assistant.receipts';
import * as repo from './assistant.repository';
import { verifyTurnTranscript } from './assistant.transcript';
import { boundedTurnEvents, deliverTurn } from './assistant.turn.delivery';
import { isSharedTurnEligible } from './assistant.turn.prompt';
import {
  assistantTurnRequestSchema,
  historyWindowSchema,
  TURN_LIMITS,
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
  const budgets = {
    ...config.budgets,
    maxFrameBytes: Math.min(config.budgets.maxFrameBytes, TURN_LIMITS.frameBytes),
    connectMs: Math.min(config.budgets.connectMs, TURN_LIMITS.connectMs),
    idleMs: Math.min(config.budgets.idleMs, TURN_LIMITS.idleMs),
    totalMs: Math.min(config.budgets.totalMs, TURN_LIMITS.totalMs),
    maxOutputBytes: Math.min(config.budgets.maxOutputBytes, TURN_LIMITS.outputBytes),
  };
  const canonicalBriefingFingerprint = generationInputFingerprint(
    createBriefingGenerationInput({
      operationVersion: config.operationVersion,
      language: config.languages[request.outputLanguage],
      resourceLanguage: grounding.resourceLanguage,
      groundingInstruction: grounding.instruction,
      sourceBible: passage.sourceBible,
      sourceLanguageCode: passage.sourceLanguageCode,
      verses: passage.verses,
      actions: SHARED_ASSISTANT_ACTIONS,
      maxOutputBytes: config.budgets.maxOutputBytes,
      cacheEpoch: config.cacheEpoch,
    })
  );
  const receipts = new TurnReceipts(key, input.userId, context);
  const verified = verifyTurnTranscript(receipts, context, request, historyWindow, {
    cacheEpoch: config.cacheEpoch,
    maxOutputBytes: budgets.maxOutputBytes,
    canonicalBriefingFingerprint,
  });
  if (!verified.ok) return fail(verified.code);
  if (Buffer.byteLength(verified.projection.generationInput.message) > config.budgets.maxInputBytes)
    return fail('context_too_large');
  const projection = verified.projection;
  const cacheProjection = verified.cachedProjection;
  const cacheKey = generationInputFingerprint((cacheProjection ?? projection).generationInput);
  const producerKey = cacheKey;
  const sharedCache = isSharedTurnEligible(request, verified.sharedBriefing);
  const operationId = crypto.randomUUID();
  const warn = () => input.logger.warn({ operationId }, 'Assistant turn cache unavailable');
  const source = (signal: AbortSignal) =>
    boundedTurnEvents(
      createAssistantClient(config, input.logger.warn.bind(input.logger), budgets).stream(
        providerRequest(projection.generationInput, btUserId(input.userId)),
        signal
      )
    );
  const deliver = (
    events: AsyncIterable<BriefingEvent>,
    deliveryVerified: typeof verified = verified
  ) =>
    ok({
      events: deliverTurn(events, receipts, deliveryVerified, operationId, input.signal),
    });
  let producer = sharedCache ? findInFlightGeneration(producerKey) : undefined;
  let completed: Awaited<ReturnType<typeof cacheRepo.findCompletedArtifact>> = null;
  let installed = false;
  if (!producer) {
    const release = sharedCache ? beginGenerationCacheLookup(producerKey) : () => {};
    try {
      completed = cacheProjection
        ? await cacheRepo.findCompletedArtifact(cacheKey, input.signal)
        : null;
      if (
        completed &&
        (!completed.markdown.trim() ||
          completed.outputContractVersion !== WIDGET_CONTRACT_VERSION ||
          completed.cacheEpoch !== config.cacheEpoch ||
          completed.markdown.length > TURN_LIMITS.outputChars ||
          Buffer.byteLength(completed.markdown) > budgets.maxOutputBytes)
      ) {
        warn();
        completed = null;
      }
    } catch {
      warn();
    } finally {
      if (!completed && sharedCache && !input.signal.aborted) {
        const result = installOrJoinGeneration(producerKey);
        producer = result.producer;
        installed = result.installed;
      }
      release();
    }
  }
  cacheRepo.requestExpiredArtifactCleanup(warn);
  if (completed) {
    const markdown = completed.markdown;
    const deliveryVerified = {
      ...verified,
      projection: cacheProjection!,
      binding: { ...verified.binding, projectionDigest: cacheKey },
    };
    return deliver(
      (async function* () {
        if (markdown) yield { type: 'briefing_delta', delta: markdown } as const;
        yield { type: 'briefing_complete', markdown } as const;
      })(),
      deliveryVerified
    );
  }
  if (input.signal.aborted) return fail('temporarily_unavailable');
  if (!sharedCache || !producer) {
    const release = acquireGeneration(input.userId);
    if (!release)
      return { ok: false, error: { code: 'generation_busy', retryable: true, retryAfter: 1 } };
    return ok({
      events: releasePrivateGeneration(
        deliverTurn(source(input.signal), receipts, verified, operationId, input.signal),
        release,
        input.signal
      ),
    });
  }
  const retained = producer;
  if (installed) {
    const release = acquireGeneration(input.userId);
    if (!release) {
      retained.publish({
        type: 'briefing_error',
        code: 'generation_busy',
        retryable: true,
        retryAfter: 1,
      });
      removeInFlightGeneration(producerKey, retained, false);
      return { ok: false, error: { code: 'generation_busy', retryable: true, retryAfter: 1 } };
    }
    const production = (async () => {
      try {
        for await (const event of source(retained.upstreamSignal)) {
          if (event.type === 'briefing_complete') {
            retained.beginCompletionWrite();
            try {
              await cacheRepo.publishCompletedArtifact(
                {
                  cacheKey,
                  markdown: event.markdown,
                  cacheEpoch: config.cacheEpoch,
                  outputContractVersion: WIDGET_CONTRACT_VERSION,
                },
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
        removeInFlightGeneration(producerKey, retained);
        release();
      }
    })();
    retained.attachProduction(production);
  }
  return deliver(retained.subscribe(input.signal));
}
