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
import { assistantBriefingRequestSchema } from './assistant.types';

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
const assistantErrorSchema = z.object({
  code: z.enum([
    'temporarily_unavailable',
    'invalid_request',
    'unsupported_language',
    'context_too_large',
  ]),
  retryable: z.boolean(),
});
const languagesSchema = z.object({
  languages: z.array(z.object({ code: z.string(), displayName: z.string() })),
  defaultLanguage: z.string(),
  englishFallback: z.literal('en'),
});
const messageError = jsonContent(createMessageObjectSchema('Error'), 'Request failed');
const assistantUnavailable = jsonContent(
  assistantErrorSchema,
  'Assistant is not configured or temporarily unavailable'
);
const validationHook = ((result: { success: boolean }, c: Context) => {
  if (result.success) return undefined;
  return c.json({ code: 'invalid_request', retryable: false }, HttpStatusCodes.BAD_REQUEST);
}) as never;

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
    [HttpStatusCodes.BAD_REQUEST]: messageError,
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
    return languages
      ? c.json(languages, HttpStatusCodes.OK)
      : c.json(
          { code: 'temporarily_unavailable', retryable: true } as const,
          HttpStatusCodes.SERVICE_UNAVAILABLE
        );
  },
  validationHook
);

function errorStatus(code: BriefingServiceErrorCode) {
  if (code === 'temporarily_unavailable') return HttpStatusCodes.SERVICE_UNAVAILABLE;
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
    'Streams normalized SSE events from the concrete BT passage-briefing operation. The server resolves canonical source text; browser-supplied draft text is not accepted or forwarded.',
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
      description: 'briefing_started, briefing_delta, and one terminal briefing event',
    },
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(assistantErrorSchema, 'Invalid request or language'),
    [HttpStatusCodes.UNAUTHORIZED]: messageError,
    [HttpStatusCodes.FORBIDDEN]: messageError,
    [HttpStatusCodes.NOT_FOUND]: messageError,
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
    const result = await createPassageBriefing({
      projectId: c.req.valid('param').projectId,
      userId: c.get('user')!.id,
      body: c.req.valid('json'),
      signal: c.req.raw.signal,
      logger: c.get('logger'),
    });
    if (!result.ok)
      return c.json(
        { code: result.code, retryable: result.retryable },
        errorStatus(result.code) as never
      );
    return streamSSE(c, async (stream) => {
      let id = 0;
      for await (const event of result.events) {
        await stream.writeSSE({
          id: String(++id),
          event: event.type,
          data: JSON.stringify(event),
        });
      }
    });
  },
  validationHook
);
