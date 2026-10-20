import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import type { RetainedBriefingProducer } from './assistant.cache';
import type { BriefingEvent } from './assistant.client';
import type { BriefingServiceErrorCode } from './assistant.types';
import type { CompletedBriefingArtifact } from './cache/assistant-cache.repository';

import {
  beginBriefingCacheLookup,
  briefingCacheKey,
  findInFlightBriefing,
  installOrJoinBriefing,
  removeInFlightBriefing,
} from './assistant.cache';
import { BtServantClient } from './assistant.client';
import {
  loadAssistantConfig,
  publicLanguages,
  resolveGrounding,
  selectOutputLanguage,
} from './assistant.config';
import { btUserId, buildBriefingPrompt, WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import * as repo from './assistant.repository';
import { assistantBriefingRequestSchema } from './assistant.types';
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
type PublicBriefingEvent =
  | (Extract<BriefingEvent, { type: 'briefing_complete' }> & {
      operationVersion: string;
      cacheEpoch: string;
      outputLanguage: string;
      outputContractVersion: string;
      cacheHit: boolean;
    })
  | BriefingEvent
  | {
      type: 'briefing_started';
      attemptId: string;
      operationVersion: string;
      cacheEpoch: string;
      outputContractVersion: string;
      references: string[];
    };
type BriefingServiceResult =
  | { ok: false; code: BriefingServiceErrorCode; retryable: boolean }
  | { ok: true; events: AsyncGenerator<PublicBriefingEvent> };

export function getAssistantLanguages(projectId: number, persisted?: string) {
  const config = loadAssistantConfig();
  if (!config) return null;
  return repo.findProjectSourceLanguage(projectId).then((sourceLanguage) => ({
    languages: publicLanguages(config),
    defaultLanguage: selectOutputLanguage(config, sourceLanguage, persisted),
    englishFallback: 'en' as const,
  }));
}

function completeEvent(
  event: Extract<BriefingEvent, { type: 'briefing_complete' }>,
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string },
  cacheHit: boolean
): PublicBriefingEvent {
  return { ...event, ...metadata, outputContractVersion: WIDGET_CONTRACT_VERSION, cacheHit };
}

async function produceSharedBriefing(input: {
  producer: RetainedBriefingProducer;
  cacheKey: string;
  artifactMetadata: Omit<CompletedBriefingArtifact, 'cacheKey' | 'markdown'>;
  client: BtServantClient;
  request: { userId: string; message: string; responseLanguageHint: string };
  onCacheWriteFailure: () => void;
}): Promise<void> {
  let settled = false;
  try {
    for await (const event of input.client.stream(input.request, input.producer.upstreamSignal)) {
      if (event.type === 'briefing_complete') {
        input.producer.beginCompletionWrite();
        try {
          await cacheRepo.publishCompletedBriefing(
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
    removeInFlightBriefing(input.cacheKey, input.producer);
  }
}

function privateEvents(input: {
  started: Extract<PublicBriefingEvent, { type: 'briefing_started' }>;
  client: BtServantClient;
  request: { userId: string; message: string; responseLanguageHint: string };
  signal: AbortSignal;
  metadata: { operationVersion: string; cacheEpoch: string; outputLanguage: string };
  logTerminal: (event: BriefingEvent | { type: 'detached' }) => void;
}): AsyncGenerator<PublicBriefingEvent> {
  return (async function* () {
    yield input.started;
    try {
      for await (const event of input.client.stream(input.request, input.signal)) {
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

function replayedEvents(
  started: Extract<PublicBriefingEvent, { type: 'briefing_started' }>,
  completed: CompletedBriefingArtifact,
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
  producer: RetainedBriefingProducer;
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
  if (!config) return { ok: false, code: 'temporarily_unavailable', retryable: true };
  const parsed = assistantBriefingRequestSchema.safeParse(input.body);
  if (!parsed.success) return { ok: false, code: 'invalid_request', retryable: false };
  if (!Object.hasOwn(config.languages, parsed.data.outputLanguage))
    return { ok: false, code: 'unsupported_language', retryable: false };
  const language = config.languages[parsed.data.outputLanguage];
  const grounding = resolveGrounding(language, parsed.data.grounding);
  if (!grounding) return { ok: false, code: 'unsupported_language', retryable: false };
  const passage = await repo.resolveCanonicalPassage({
    projectId: input.projectId,
    bookCode: parsed.data.bookCode,
    chapter: parsed.data.chapter,
    activeVerse: parsed.data.activeVerse,
  });
  if (!passage) return { ok: false, code: 'invalid_request', retryable: false };
  const prompt = buildBriefingPrompt({
    operationVersion: config.operationVersion,
    language,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
    sourceBible: passage.sourceBible,
    sourceLanguageCode: passage.sourceLanguageCode,
    verses: passage.verses,
  });
  if (Buffer.byteLength(prompt) > config.budgets.maxInputBytes)
    return { ok: false, code: 'context_too_large', retryable: false };
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
  const createClient = () =>
    new BtServantClient({
      baseUrl: config.baseUrl,
      engineKey: config.engineKey,
      org: config.org,
      ...config.budgets,
    });
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
  const request = {
    userId: btUserId(input.userId),
    message: prompt,
    responseLanguageHint: language.responseLanguageHint,
  };
  if (parsed.data.ignore_cache)
    return {
      ok: true,
      events: privateEvents({
        started,
        client: createClient(),
        request,
        signal: input.signal,
        metadata,
        logTerminal,
      }),
    };
  const cacheKey = briefingCacheKey({
    operationVersion: config.operationVersion,
    profileVersion: config.profileVersion,
    resourcePolicyVersion: config.resourcePolicyVersion,
    cacheEpoch: config.cacheEpoch,
    maxOutputBytes: config.budgets.maxOutputBytes,
    language,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
    passage,
  });
  let producer = findInFlightBriefing(cacheKey);
  let completed: CompletedBriefingArtifact | null = null;
  let installed = false;
  if (!producer) {
    const releaseLookup = beginBriefingCacheLookup(cacheKey);
    try {
      completed = await cacheRepo.findCompletedBriefing(cacheKey);
    } catch {
      input.logger.warn({ attemptId }, 'Assistant briefing cache read failed');
    } finally {
      if (!completed) {
        const installation = installOrJoinBriefing(cacheKey);
        producer = installation.producer;
        installed = installation.installed;
      }
      releaseLookup();
    }
  }
  cacheRepo.requestExpiredBriefingCleanup(() =>
    input.logger.warn({ attemptId }, 'Assistant briefing cache cleanup failed')
  );
  if (completed)
    return { ok: true, events: replayedEvents(started, completed, metadata, logTerminal) };
  if (!producer) return { ok: false, code: 'temporarily_unavailable', retryable: true };
  if (installed) {
    const production = produceSharedBriefing({
      producer,
      cacheKey,
      artifactMetadata: {
        operationVersion: config.operationVersion,
        profileVersion: config.profileVersion,
        resourcePolicyVersion: config.resourcePolicyVersion,
        cacheEpoch: config.cacheEpoch,
        outputContractVersion: WIDGET_CONTRACT_VERSION,
        responseLanguageHint: language.responseLanguageHint,
        resourceLanguage: grounding.resourceLanguage,
        sourceLanguageCode: passage.sourceLanguageCode,
      },
      client: createClient(),
      request,
      onCacheWriteFailure: () =>
        input.logger.warn({ attemptId }, 'Assistant briefing cache write failed'),
    });
    producer.attachProduction(production);
  }
  return {
    ok: true,
    events: sharedEvents({ started, producer, signal: input.signal, metadata, logTerminal }),
  };
}
