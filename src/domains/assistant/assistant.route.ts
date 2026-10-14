import { z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { BtServantClient } from './assistant.client';
import {
  loadAssistantConfig,
  publicLanguages,
  resolveGrounding,
  selectOutputLanguage,
} from './assistant.config';
import { btUserId, buildBriefingPrompt, WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import { findProjectSourceLanguage, resolveCanonicalPassage } from './assistant.repository';

const requestSchema = z.object({
  bookCode: z.string().min(3).max(50),
  chapter: z.number().int().positive(),
  activeVerse: z.number().int().positive(),
  outputLanguage: z.string().min(1).max(20),
  grounding: z.enum(['configured', 'output_language', 'english']).optional(),
});
const guards = [
  authenticateUser,
  requirePermission(PERMISSIONS.PROJECT_VIEW),
  requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
] as const;

server.get('/projects/:projectId/assistant/languages', ...guards, async (c) => {
  const config = loadAssistantConfig();
  if (!config) return c.json({ code: 'temporarily_unavailable', retryable: true }, 503);
  const sourceLanguage = await findProjectSourceLanguage(Number(c.req.param('projectId')));
  const persisted = c.req.query('selected');
  return c.json({
    languages: publicLanguages(config),
    defaultLanguage: selectOutputLanguage(config, sourceLanguage, persisted),
    englishFallback: 'en',
  });
});

server.post('/projects/:projectId/assistant/briefing', ...guards, async (c) => {
  const config = loadAssistantConfig();
  if (!config) return c.json({ code: 'temporarily_unavailable', retryable: true }, 503);
  const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: 'invalid_request', retryable: false }, 400);
  if (!Object.hasOwn(config.languages, parsed.data.outputLanguage))
    return c.json({ code: 'unsupported_language', retryable: false }, 400);
  const language = config.languages[parsed.data.outputLanguage];
  const grounding = resolveGrounding(language, parsed.data.grounding);
  if (!grounding) return c.json({ code: 'unsupported_language', retryable: false }, 400);
  const passage = await resolveCanonicalPassage({
    projectId: Number(c.req.param('projectId')),
    bookCode: parsed.data.bookCode,
    chapter: parsed.data.chapter,
    activeVerse: parsed.data.activeVerse,
  });
  if (!passage) return c.json({ code: 'invalid_request', retryable: false }, 400);
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
    return c.json({ code: 'context_too_large', retryable: false }, 413);

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
  const client = new BtServantClient({
    baseUrl: config.baseUrl,
    engineKey: config.engineKey,
    org: config.org,
    ...config.budgets,
  });
  return streamSSE(c, async (stream) => {
    let id = 0;
    await stream.writeSSE({
      id: String(++id),
      event: 'briefing_started',
      data: JSON.stringify({
        type: 'briefing_started',
        attemptId,
        operationVersion: config.operationVersion,
        cacheEpoch: config.cacheEpoch,
        outputContractVersion: WIDGET_CONTRACT_VERSION,
        references: passage.verses.map((v) => `${v.bookCode} ${v.chapter}:${v.verse}`),
      }),
    });
    for await (const event of client.stream(
      {
        userId: btUserId(user.id),
        message: prompt,
        responseLanguageHint: language.responseLanguageHint,
      },
      c.req.raw.signal
    )) {
      const publicEvent =
        event.type === 'briefing_complete'
          ? {
              ...event,
              operationVersion: config.operationVersion,
              cacheEpoch: config.cacheEpoch,
              outputContractVersion: WIDGET_CONTRACT_VERSION,
              outputLanguage: parsed.data.outputLanguage,
            }
          : event;
      await stream.writeSSE({
        id: String(++id),
        event: event.type,
        data: JSON.stringify(publicEvent),
      });
      if (event.type === 'briefing_complete' || event.type === 'briefing_error') {
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
      }
    }
  });
});
