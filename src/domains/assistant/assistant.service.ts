import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { Result } from '@/lib/types';

import { ok } from '@/lib/types';

import type { RetainedAssistantGeneration } from './assistant.cache';
import type { BriefingEvent, BtServantClient } from './assistant.client';
import type { AssistantError, PublicBriefingEvent } from './assistant.types';
import type { CompletedAssistantArtifact } from './cache/assistant-cache.repository';

import {
  beginGenerationCacheLookup,
  findInFlightGeneration,
  installOrJoinGeneration,
  removeInFlightGeneration,
} from './assistant.cache';
import {
  assistantLanguageConfigurationFailure,
  loadAssistantConfig,
  publicLanguages,
  resolveGrounding,
  selectOutputLanguage,
} from './assistant.config';
import { resolveTurnContext } from './assistant.context';
import { signBriefingDelivery } from './assistant.delivery';
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
import * as repo from './assistant.repository';
import { assistantBriefingRequestSchema, assistantFailure } from './assistant.types';
import * as cacheRepo from './cache/assistant-cache.repository';

interface AssistantLogger {
  info: (data: unknown, message: string) => void;
  warn: (data: unknown, message: string) => void;
}
interface CreateBriefingInput {
  projectId: number;
  userId: number;
  body: unknown;
  signal: AbortSignal;
  logger: AssistantLogger;
}
type BriefingServiceResult = Result<
  { events: AsyncGenerator<PublicBriefingEvent> },
  AssistantError
>;

export async function getAssistantLanguages(projectId: number, persisted?: string) {
  const config = loadAssistantConfig();
  if (!config)
    return assistantFailure(
      assistantLanguageConfigurationFailure()?.code ?? 'temporarily_unavailable'
    );
  const sourceLanguage = await repo.findProjectSourceLanguage(projectId);
  return ok({
    languages: publicLanguages(config),
    defaultLanguage: selectOutputLanguage(config, sourceLanguage, persisted),
    englishFallback: 'en' as const,
  });
}

function completeEvent(
  event: Extract<BriefingEvent, { type: 'briefing_complete' }>,
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string },
  cacheHit: boolean
): PublicBriefingEvent {
  return { ...event, ...metadata, outputContractVersion: WIDGET_CONTRACT_VERSION, cacheHit };
}

async function produceSharedBriefing(input: {
  producer: RetainedAssistantGeneration;
  cacheKey: string;
  artifactMetadata: Omit<CompletedAssistantArtifact, 'cacheKey' | 'markdown'>;
  client: BtServantClient;
  request: { userId: string; message: string; responseLanguageHint: string };
  onCacheWriteFailure: () => void;
}): Promise<void> {
  let settled = false;
  try {
    for await (const event of input.client.stream(input.request, input.producer.upstreamSignal)) {
      if (event.type === 'briefing_complete') {
        if (!event.markdown.trim()) {
          input.producer.publish({
            type: 'briefing_error',
            code: 'malformed_upstream_response',
            retryable: false,
          });
          settled = true;
          break;
        }
        input.producer.beginCompletionWrite();
        try {
          await cacheRepo.publishCompletedArtifact(
            { cacheKey: input.cacheKey, markdown: event.markdown, ...input.artifactMetadata },
            input.producer.upstreamSignal
          );
        } catch {
          input.onCacheWriteFailure();
        }
        input.producer.finishCompletionWrite(event);
        settled = true;
        break;
      }
      if (!input.producer.publish(event) || event.type === 'briefing_error') {
        settled = true;
        break;
      }
    }
  } catch {
    input.producer.publish({
      type: 'briefing_error',
      code: 'temporarily_unavailable',
      retryable: true,
    });
    settled = true;
  } finally {
    if (!settled)
      input.producer.publish({
        type: 'briefing_error',
        code: 'malformed_upstream_response',
        retryable: false,
      });
    removeInFlightGeneration(input.cacheKey, input.producer);
  }
}

function privateEvents(input: {
  started: Extract<PublicBriefingEvent, { type: 'briefing_started' }>;
  client: BtServantClient;
  request: { userId: string; message: string; responseLanguageHint: string };
  signal: AbortSignal;
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string };
  logTerminal: (event: BriefingEvent | { type: 'detached' }) => void;
  release: () => void;
}): AsyncGenerator<PublicBriefingEvent> {
  return releasePrivateGeneration(
    (async function* () {
      try {
        yield input.started;
        for await (const event of input.client.stream(input.request, input.signal)) {
          if (event.type === 'briefing_complete' && !event.markdown.trim()) {
            const failure = {
              type: 'briefing_error',
              code: 'malformed_upstream_response',
              retryable: false,
            } as const;
            yield failure;
            input.logTerminal(failure);
            return;
          }
          yield event.type === 'briefing_complete'
            ? completeEvent(event, input.metadata, false)
            : event;
          if (event.type === 'briefing_complete' || event.type === 'briefing_error')
            input.logTerminal(event);
        }
      } finally {
        if (input.signal.aborted) input.logTerminal({ type: 'detached' });
      }
    })(),
    input.release,
    input.signal
  );
}

function replayedEvents(
  started: Extract<PublicBriefingEvent, { type: 'briefing_started' }>,
  completed: CompletedAssistantArtifact,
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string },
  logTerminal: (event: BriefingEvent) => void
): AsyncGenerator<PublicBriefingEvent> {
  return (async function* () {
    yield started;
    yield { type: 'briefing_delta', delta: completed.markdown };
    const event = { type: 'briefing_complete', markdown: completed.markdown } as const;
    yield completeEvent(event, metadata, true);
    logTerminal(event);
  })();
}

function sharedEvents(input: {
  started: Extract<PublicBriefingEvent, { type: 'briefing_started' }>;
  producer: RetainedAssistantGeneration;
  signal: AbortSignal;
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string };
  logTerminal: (event: BriefingEvent | { type: 'detached' }) => void;
}): AsyncGenerator<PublicBriefingEvent> {
  return (async function* () {
    yield input.started;
    try {
      for await (const event of input.producer.subscribe(input.signal)) {
        yield event.type === 'briefing_complete'
          ? completeEvent(event, input.metadata, false)
          : event;
        if (event.type === 'briefing_complete' || event.type === 'briefing_error')
          input.logTerminal(event);
      }
    } finally {
      if (input.signal.aborted) input.logTerminal({ type: 'detached' });
    }
  })();
}

export async function createPassageBriefing(
  input: CreateBriefingInput
): Promise<BriefingServiceResult> {
  const config = loadAssistantConfig();
  if (!config)
    return assistantFailure(
      assistantLanguageConfigurationFailure()?.code ?? 'temporarily_unavailable'
    );
  const parsed = assistantBriefingRequestSchema.safeParse(input.body);
  if (!parsed.success) return assistantFailure('invalid_request');
  if (!Object.hasOwn(config.languages, parsed.data.outputLanguage))
    return assistantFailure('unsupported_language');
  const language = config.languages[parsed.data.outputLanguage];
  const grounding = resolveGrounding(language, parsed.data.grounding);
  if (!grounding) return assistantFailure('unsupported_language');
  const passage = await repo.resolveCanonicalPassage({
    projectId: input.projectId,
    bookCode: parsed.data.bookCode,
    chapter: parsed.data.chapter,
    activeVerse: parsed.data.activeVerse,
  });
  if (!passage) return assistantFailure('invalid_request');
  const sharedCache = !parsed.data.ignore_cache;
  const generationInput = createBriefingGenerationInput({
    operationVersion: config.operationVersion,
    language,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
    sourceBible: passage.sourceBible,
    sourceLanguageCode: passage.sourceLanguageCode,
    verses: passage.verses,
    actions: sharedCache ? SHARED_ASSISTANT_ACTIONS : parsed.data.actions,
    maxOutputBytes: config.budgets.maxOutputBytes,
    cacheEpoch: config.cacheEpoch,
  });
  if (Buffer.byteLength(generationInput.message) > config.budgets.maxInputBytes)
    return assistantFailure('context_too_large');
  const context = resolveTurnContext({
    projectId: input.projectId,
    passage,
    config,
    outputLanguage: parsed.data.outputLanguage,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
  });
  const generationFingerprint = generationInputFingerprint(generationInput);
  const delivery = (events: AsyncGenerator<PublicBriefingEvent>) =>
    signBriefingDelivery(events, input.userId, context, generationFingerprint);
  const attemptId = crypto.randomUUID();
  const contextHash = createHash('sha256')
    .update(
      JSON.stringify({
        projectId: input.projectId,
        references: passage.verses.map((verse) => [verse.bookCode, verse.chapter, verse.verse]),
        outputLanguage: parsed.data.outputLanguage,
        grounding: parsed.data.grounding ?? 'configured',
        operationVersion: config.operationVersion,
      })
    )
    .digest('hex');
  const startedAt = Date.now();
  input.logger.info({ attemptId, contextHash }, 'Assistant briefing started');
  let terminalLogged = false;
  const logTerminal = (event: BriefingEvent | { type: 'detached' }) => {
    if (terminalLogged) return;
    terminalLogged = true;
    input.logger.info(
      {
        attemptId,
        contextHash,
        outcome: event.type,
        ...(event.type === 'briefing_error' ? { failureCode: event.code } : {}),
        durationMs: Date.now() - startedAt,
      },
      'Assistant briefing finished'
    );
  };
  input.signal.addEventListener('abort', () => logTerminal({ type: 'detached' }), { once: true });
  const createClient = () => createAssistantClient(config, input.logger.warn.bind(input.logger));
  const metadata = {
    operationVersion: config.operationVersion,
    cacheEpoch: config.cacheEpoch,
    outputLanguage: parsed.data.outputLanguage,
  };
  const started = {
    type: 'briefing_started',
    attemptId,
    operationVersion: config.operationVersion,
    cacheEpoch: config.cacheEpoch,
    outputContractVersion: WIDGET_CONTRACT_VERSION,
    references: passage.verses.map((verse) => `${verse.bookCode} ${verse.chapter}:${verse.verse}`),
  } as const;
  const request = providerRequest(generationInput, btUserId(input.userId));
  if (parsed.data.ignore_cache) {
    const release = acquireGeneration(input.userId);
    if (!release)
      return { ok: false, error: { code: 'generation_busy', retryable: true, retryAfter: 1 } };
    return ok({
      events: delivery(
        privateEvents({
          started,
          client: createClient(),
          request,
          signal: input.signal,
          metadata,
          logTerminal,
          release,
        })
      ),
    });
  }
  const cacheKey = generationFingerprint;
  let producer = findInFlightGeneration(cacheKey);
  let completed: CompletedAssistantArtifact | null = null;
  let installed = false;
  if (!producer) {
    const releaseLookup = beginGenerationCacheLookup(cacheKey);
    try {
      completed = await cacheRepo.findCompletedArtifact(cacheKey);
      if (
        completed &&
        (!completed.markdown.trim() ||
          completed.cacheEpoch !== config.cacheEpoch ||
          completed.outputContractVersion !== WIDGET_CONTRACT_VERSION)
      )
        completed = null;
    } catch {
      input.logger.warn({ attemptId }, 'Assistant briefing cache read failed');
    } finally {
      if (!completed) {
        const installation = installOrJoinGeneration(cacheKey);
        producer = installation.producer;
        installed = installation.installed;
      }
      releaseLookup();
    }
  }
  cacheRepo.requestExpiredArtifactCleanup(() =>
    input.logger.warn({ attemptId }, 'Assistant briefing cache cleanup failed')
  );
  if (completed)
    return ok({
      events: delivery(replayedEvents(started, completed, metadata, logTerminal)),
    });
  if (!producer) return assistantFailure('temporarily_unavailable');
  if (installed) {
    const release = acquireGeneration(input.userId);
    if (!release) {
      producer.publish({
        type: 'briefing_error',
        code: 'generation_busy',
        retryable: true,
        retryAfter: 1,
      });
      removeInFlightGeneration(cacheKey, producer, false);
      return { ok: false, error: { code: 'generation_busy', retryable: true, retryAfter: 1 } };
    }
    const production = produceSharedBriefing({
      producer,
      cacheKey,
      artifactMetadata: {
        cacheEpoch: config.cacheEpoch,
        outputContractVersion: WIDGET_CONTRACT_VERSION,
      },
      client: createClient(),
      request,
      onCacheWriteFailure: () =>
        input.logger.warn({ attemptId }, 'Assistant briefing cache write failed'),
    }).finally(release);
    producer.attachProduction(production);
  }
  return ok({
    events: delivery(
      sharedEvents({ started, producer, signal: input.signal, metadata, logTerminal })
    ),
  });
}
