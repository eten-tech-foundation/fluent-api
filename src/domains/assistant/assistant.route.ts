import { z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as HttpStatusCodes from 'stoker/http-status-codes';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import type { RetainedBriefingProducer } from './assistant.cache';
import type { BriefingEvent } from './assistant.client';

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
import {
  findCompletedBriefing,
  findProjectSourceLanguage,
  publishCompletedBriefing,
  requestExpiredBriefingCleanup,
  resolveCanonicalPassage,
} from './assistant.service';

const requestSchema = z.object({
  bookCode: z.string().min(3).max(50),
  chapter: z.number().int().positive(),
  activeVerse: z.number().int().positive(),
  outputLanguage: z.string().min(1).max(20),
  grounding: z.enum(['configured', 'output_language', 'english']).optional(),
  ignore_cache: z.boolean().optional(),
});
const guards = [
  authenticateUser,
  requirePermission(PERMISSIONS.PROJECT_VIEW),
  requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
] as const;

server.get('/projects/:projectId/assistant/languages', ...guards, async (c) => {
  const config = loadAssistantConfig();
  if (!config)
    return c.json(
      { code: 'temporarily_unavailable', retryable: true },
      HttpStatusCodes.SERVICE_UNAVAILABLE
    );
  const sourceLanguage = await findProjectSourceLanguage(Number(c.req.param('projectId')));
  const persisted = c.req.query('selected');
  return c.json({
    languages: publicLanguages(config),
    defaultLanguage: selectOutputLanguage(config, sourceLanguage, persisted),
    englishFallback: 'en',
  });
});

function completeEvent(
  event: Extract<BriefingEvent, { type: 'briefing_complete' }>,
  metadata: {
    operationVersion: string;
    cacheEpoch: string;
    outputLanguage: string;
  },
  cacheHit: boolean
) {
  return {
    ...event,
    ...metadata,
    outputContractVersion: WIDGET_CONTRACT_VERSION,
    cacheHit,
  };
}

async function produceSharedBriefing(input: {
  producer: RetainedBriefingProducer;
  cacheKey: string;
  artifactMetadata: Omit<Parameters<typeof publishCompletedBriefing>[0], 'cacheKey' | 'markdown'>;
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
          await publishCompletedBriefing(
            {
              cacheKey: input.cacheKey,
              markdown: event.markdown,
              ...input.artifactMetadata,
            },
            input.producer.upstreamSignal
          );
        } catch {
          input.onCacheWriteFailure();
        }
        // Once BT supplied a valid completion it remains authoritative even if cache transport
        // teardown cannot prove whether PostgreSQL committed the disposable artifact.
        input.producer.finishCompletionWrite(event);
        settled = true;
        break;
      }
      if (!input.producer.publish(event)) {
        settled = true;
        break;
      }
      if (event.type === 'briefing_error') {
        settled = true;
        break;
      }
    }
  } catch {
    const event = {
      type: 'briefing_error',
      code: 'temporarily_unavailable',
      retryable: true,
    } as const;
    input.producer.publish(event);
    settled = true;
  } finally {
    if (!settled) {
      const event = {
        type: 'briefing_error',
        code: 'malformed_upstream_response',
        retryable: false,
      } as const;
      input.producer.publish(event);
    }
    // Completion is retained after its database query has settled and before this removal.
    removeInFlightBriefing(input.cacheKey, input.producer);
  }
}

server.post('/projects/:projectId/assistant/briefing', ...guards, async (c) => {
  const config = loadAssistantConfig();
  if (!config)
    return c.json(
      { code: 'temporarily_unavailable', retryable: true },
      HttpStatusCodes.SERVICE_UNAVAILABLE
    );
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    return c.json({ code: 'invalid_request', retryable: false }, HttpStatusCodes.BAD_REQUEST);
  if (!Object.hasOwn(config.languages, parsed.data.outputLanguage))
    return c.json({ code: 'unsupported_language', retryable: false }, HttpStatusCodes.BAD_REQUEST);
  const language = config.languages[parsed.data.outputLanguage];
  const grounding = resolveGrounding(language, parsed.data.grounding);
  if (!grounding)
    return c.json({ code: 'unsupported_language', retryable: false }, HttpStatusCodes.BAD_REQUEST);
  const passage = await resolveCanonicalPassage({
    projectId: Number(c.req.param('projectId')),
    bookCode: parsed.data.bookCode,
    chapter: parsed.data.chapter,
    activeVerse: parsed.data.activeVerse,
  });
  if (!passage)
    return c.json({ code: 'invalid_request', retryable: false }, HttpStatusCodes.BAD_REQUEST);
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
    return c.json(
      { code: 'context_too_large', retryable: false },
      HttpStatusCodes.REQUEST_TOO_LONG
    );

  const user = c.get('user')!;
  const attemptId = crypto.randomUUID();
  const contextHash = createHash('sha256')
    .update(
      JSON.stringify({
        projectId: Number(c.req.param('projectId')),
        references: passage.verses.map((v) => [v.bookCode, v.chapter, v.verse]),
        outputLanguage: parsed.data.outputLanguage,
        grounding: parsed.data.grounding ?? 'configured',
        operationVersion: config.operationVersion,
      })
    )
    .digest('hex');
  const startedAt = Date.now();
  c.get('logger').info({ attemptId, contextHash }, 'Assistant briefing started');
  const createClient = () =>
    new BtServantClient({
      baseUrl: config.baseUrl,
      engineKey: config.engineKey,
      org: config.org,
      ...config.budgets,
    });
  const streamMetadata = {
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
    references: passage.verses.map((v) => `${v.bookCode} ${v.chapter}:${v.verse}`),
  };
  let terminalLogged = false;
  const logTerminal = (event: BriefingEvent | { type: 'detached' }) => {
    if (terminalLogged) return;
    terminalLogged = true;
    c.get('logger').info(
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
  c.req.raw.signal.addEventListener('abort', () => logTerminal({ type: 'detached' }), {
    once: true,
  });

  if (parsed.data.ignore_cache) {
    return streamSSE(c, async (stream) => {
      let id = 0;
      try {
        await stream.writeSSE({
          id: String(++id),
          event: 'briefing_started',
          data: JSON.stringify(started),
        });
        for await (const event of createClient().stream(
          {
            userId: btUserId(user.id),
            message: prompt,
            responseLanguageHint: language.responseLanguageHint,
          },
          c.req.raw.signal
        )) {
          const publicEvent =
            event.type === 'briefing_complete'
              ? completeEvent(event, streamMetadata, false)
              : event;
          await stream.writeSSE({
            id: String(++id),
            event: event.type,
            data: JSON.stringify(publicEvent),
          });
          if (event.type === 'briefing_complete' || event.type === 'briefing_error')
            logTerminal(event);
        }
      } finally {
        if (c.req.raw.signal.aborted) logTerminal({ type: 'detached' });
      }
    });
  }

  const identity = {
    operationVersion: config.operationVersion,
    profileVersion: config.profileVersion,
    resourcePolicyVersion: config.resourcePolicyVersion,
    cacheEpoch: config.cacheEpoch,
    maxOutputBytes: config.budgets.maxOutputBytes,
    language,
    resourceLanguage: grounding.resourceLanguage,
    groundingInstruction: grounding.instruction,
    passage,
  };
  const cacheKey = briefingCacheKey(identity);
  let producer = findInFlightBriefing(cacheKey);
  let completed = null;
  let installed = false;
  if (!producer) {
    const releaseLookup = beginBriefingCacheLookup(cacheKey);
    try {
      completed = await findCompletedBriefing(cacheKey);
    } catch {
      c.get('logger').warn({ attemptId }, 'Assistant briefing cache read failed');
    } finally {
      if (!completed) {
        // This recheck/install stays synchronous while the lookup lease is held. A producer whose
        // commit crossed the SELECT snapshot remains retained until this caller can join it.
        const installation = installOrJoinBriefing(cacheKey);
        producer = installation.producer;
        installed = installation.installed;
      }
      releaseLookup();
    }
  }
  requestExpiredBriefingCleanup(() =>
    c.get('logger').warn({ attemptId }, 'Assistant briefing cache cleanup failed')
  );

  if (completed) {
    return streamSSE(c, async (stream) => {
      let id = 0;
      await stream.writeSSE({
        id: String(++id),
        event: 'briefing_started',
        data: JSON.stringify(started),
      });
      await stream.writeSSE({
        id: String(++id),
        event: 'briefing_delta',
        data: JSON.stringify({ type: 'briefing_delta', delta: completed.markdown }),
      });
      const event = { type: 'briefing_complete', markdown: completed.markdown } as const;
      await stream.writeSSE({
        id: String(++id),
        event: 'briefing_complete',
        data: JSON.stringify(completeEvent(event, streamMetadata, true)),
      });
      logTerminal(event);
    });
  }

  if (!producer) throw new Error('Assistant briefing producer installation invariant failed');

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
      request: {
        userId: btUserId(user.id),
        message: prompt,
        responseLanguageHint: language.responseLanguageHint,
      },
      onCacheWriteFailure: () =>
        c.get('logger').warn({ attemptId }, 'Assistant briefing cache write failed'),
    });
    producer.attachProduction(production);
    void production;
  }

  const sharedProducer = producer;
  return streamSSE(c, async (stream) => {
    let id = 0;
    await stream.writeSSE({
      id: String(++id),
      event: 'briefing_started',
      data: JSON.stringify(started),
    });
    try {
      for await (const event of sharedProducer.subscribe(c.req.raw.signal)) {
        const publicEvent =
          event.type === 'briefing_complete' ? completeEvent(event, streamMetadata, false) : event;
        await stream.writeSSE({
          id: String(++id),
          event: event.type,
          data: JSON.stringify(publicEvent),
        });
        if (event.type === 'briefing_complete' || event.type === 'briefing_error')
          logTerminal(event);
      }
    } finally {
      if (c.req.raw.signal.aborted) logTerminal({ type: 'detached' });
    }
  });
});
