import type { Context } from 'hono';

import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent, jsonContentRequired } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { requireProjectAccess } from '@/domains/projects/project-auth.middleware';
import { PROJECT_ACTIONS } from '@/domains/projects/projects.types';
import { PERMISSIONS } from '@/lib/permissions';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import type { BriefingServiceErrorCode } from './assistant.types';

import { createPassageBriefing, getAssistantLanguages } from './assistant.service';
import { writeAssistantEvents } from './assistant.stream';
import { admitTurnBody } from './assistant.turn.admission';
import { createPassageTurn } from './assistant.turn.service';
import { assistantTurnRequestSchema, TURN_PROTOCOL } from './assistant.turn.types';
import { assistantBriefingRequestSchema, assistantErrorSchema } from './assistant.types';

const guards = [
  authenticateUser,
  requirePermission(PERMISSIONS.PROJECT_VIEW),
  requireProjectAccess(PROJECT_ACTIONS.READ, 'projectId'),
] as const;
const projectParams = z.object({
  projectId: z.coerce
    .number()
    .int()
    .positive()
    .openapi({
      param: { name: 'projectId', in: 'path', required: true },
      description: 'Fluent project ID',
      example: 7,
    }),
});
const languagesSchema = z.object({
  languages: z.array(z.object({ code: z.string(), displayName: z.string() })),
  defaultLanguage: z.string(),
  englishFallback: z.literal('en'),
});
const messageErrorSchema = createMessageObjectSchema('Error');
const messageError = jsonContent(messageErrorSchema, 'Request failed');
const badRequest = jsonContent(
  z.union([assistantErrorSchema, messageErrorSchema]),
  'Invalid path, request body, or language'
);
const assistantUnavailable = jsonContent(
  assistantErrorSchema,
  'Assistant is not configured, has invalid language configuration, or is temporarily unavailable'
);
const validationHook = (result: { success: boolean }, c: Context) => {
  if (result.success) return undefined;
  return c.json(
    { code: 'invalid_request' as const, retryable: false },
    HttpStatusCodes.BAD_REQUEST
  );
};

const languagesRoute = createRoute({
  tags: ['Assistant'],
  method: 'get',
  path: '/projects/{projectId}/assistant/languages',
  middleware: [...guards],
  summary: 'List configured Assistant output languages',
  request: {
    params: projectParams,
    query: z.object({ selected: z.string().optional() }),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(languagesSchema, 'Public language choices and default'),
    [HttpStatusCodes.BAD_REQUEST]: badRequest,
    [HttpStatusCodes.UNAUTHORIZED]: messageError,
    [HttpStatusCodes.FORBIDDEN]: messageError,
    [HttpStatusCodes.NOT_FOUND]: messageError,
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: messageError,
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: assistantUnavailable,
  },
});

server.openapi(
  languagesRoute,
  async (c) => {
    const languages = await getAssistantLanguages(
      c.req.valid('param').projectId,
      c.req.valid('query').selected
    );
    return languages.ok
      ? c.json(languages.data, HttpStatusCodes.OK)
      : c.json(languages.error, HttpStatusCodes.SERVICE_UNAVAILABLE);
  },
  validationHook
);

function errorStatus(code: BriefingServiceErrorCode | 'context_changed') {
  if (code === 'temporarily_unavailable' || code === 'invalid_configuration')
    return HttpStatusCodes.SERVICE_UNAVAILABLE;
  if (code === 'generation_busy') return HttpStatusCodes.TOO_MANY_REQUESTS;
  if (code === 'context_too_large') return HttpStatusCodes.REQUEST_TOO_LONG;
  return HttpStatusCodes.BAD_REQUEST;
}

const briefingRoute = createRoute({
  tags: ['Assistant'],
  method: 'post',
  path: '/projects/{projectId}/assistant/briefing',
  middleware: [...guards],
  summary: 'Stream a grounded BT passage briefing',
  description:
    'Streams normalized SSE events from the concrete BT passage-briefing operation. The server resolves canonical source text; browser-supplied draft text is not accepted or forwarded. Shared-capable generation uses the server canonical suggested-question action definition; a guaranteed private cache-bypass miss may use the bounded client action catalog. Authorized deliveries add fluent-turn-v1 contextReceipt, operationId and accumulated prefix receipts when continuation signing is configured; otherwise continuationUnavailable explains why briefing remains read-only.',
  request: {
    params: projectParams,
    body: jsonContentRequired(
      assistantBriefingRequestSchema,
      'Passage identity, output language, grounding choice, and optional cache bypass'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { 'text/event-stream': { schema: z.string() } },
      description:
        'briefing_started, briefing_delta, and one terminal briefing event; periodic safe SSE comments keep the connection active',
    },
    [HttpStatusCodes.BAD_REQUEST]: badRequest,
    [HttpStatusCodes.UNAUTHORIZED]: messageError,
    [HttpStatusCodes.FORBIDDEN]: messageError,
    [HttpStatusCodes.NOT_FOUND]: messageError,
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      assistantErrorSchema,
      'This user already has an upstream generation in this API process; retry before starting output'
    ),
    [HttpStatusCodes.REQUEST_TOO_LONG]: jsonContent(
      assistantErrorSchema,
      'Resolved source context exceeds the configured input budget'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: messageError,
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: assistantUnavailable,
  },
});

server.openapi(
  briefingRoute,
  async (c) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    const result = await createPassageBriefing({
      projectId: c.req.valid('param').projectId,
      userId: c.get('user')!.id,
      body: c.req.valid('json'),
      signal: controller.signal,
      logger: c.get('logger'),
    });
    if (!result.ok) {
      c.req.raw.signal.removeEventListener('abort', abort);
      return c.json(result.error, errorStatus(result.error.code));
    }
    return streamSSE(c, async (stream) => {
      stream.onAbort(abort);
      try {
        await writeAssistantEvents(stream, result.data.events);
      } finally {
        abort();
        c.req.raw.signal.removeEventListener('abort', abort);
      }
    });
  },
  validationHook
);

const turnRoute = createRoute({
  tags: ['Assistant'],
  method: 'post',
  path: '/projects/{projectId}/assistant/turns',
  middleware: [...guards, admitTurnBody],
  summary: 'Stream a grounded passage follow-up',
  description:
    'Verifies the complete visible transcript against freshly authorized source context. Reads exact completed artifacts; dont_cache defaults true and forbids sharing or publication on a miss. Only a pristine first turn matching a signed canonical suggested-question action can use the shared artifact path. Streams atomic text and actor-bound prefix receipts without terminal text replacement.',
  request: {
    params: projectParams,
    body: jsonContentRequired(
      assistantTurnRequestSchema,
      'Bounded signed visible branch and submission'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: {
      content: { 'text/event-stream': { schema: z.string() } },
      description:
        'turn_started, turn_delta, and one terminal turn_complete or turn_error; context_changed occurs before start; periodic safe SSE comments keep the connection active',
    },
    [HttpStatusCodes.BAD_REQUEST]: badRequest,
    [HttpStatusCodes.UNAUTHORIZED]: messageError,
    [HttpStatusCodes.FORBIDDEN]: messageError,
    [HttpStatusCodes.NOT_FOUND]: messageError,
    [HttpStatusCodes.TOO_MANY_REQUESTS]: jsonContent(
      assistantErrorSchema,
      'This user already has an upstream generation in this API process; retry before starting output'
    ),
    [HttpStatusCodes.REQUEST_TOO_LONG]: jsonContent(
      assistantErrorSchema,
      'Raw body or context exceeds budget'
    ),
    [HttpStatusCodes.INTERNAL_SERVER_ERROR]: messageError,
    [HttpStatusCodes.SERVICE_UNAVAILABLE]: assistantUnavailable,
  },
});
server.openapi(
  turnRoute,
  async (c) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    const result = await createPassageTurn({
      projectId: c.req.valid('param').projectId,
      userId: c.get('user')!.id,
      body: c.req.valid('json'),
      signal: controller.signal,
      logger: c.get('logger'),
    });
    if (!result.ok && result.error.code !== 'context_changed') {
      c.req.raw.signal.removeEventListener('abort', abort);
      return c.json(result.error, errorStatus(result.error.code));
    }
    return streamSSE(c, async (stream) => {
      stream.onAbort(abort);
      try {
        if (!result.ok) {
          const event = { protocol: TURN_PROTOCOL, type: 'context_changed' } as const;
          await stream.writeSSE({ id: '1', event: event.type, data: JSON.stringify(event) });
          return;
        }
        await writeAssistantEvents(stream, result.data.events);
      } finally {
        abort();
        c.req.raw.signal.removeEventListener('abort', abort);
      }
    });
  },
  validationHook
);
