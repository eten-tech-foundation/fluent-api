import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { requireAiToolsAccess } from './ai-tools-auth.middleware';
import { callRepeatedWords } from './ai-tools.service';
import { RepeatedWordsRequestSchema, RepeatedWordsResponseSchema } from './ai-tools.types';

// Standard fluent-api error body shape ({ error, code, details }) used for all
// non-2xx responses, per decision D9 / §10.3 — successes pass the fluent-ai
// envelope through verbatim, while errors conform to fluent-api's conventions.
const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});

// ─── POST /ai/tools/greek-room/repeated-words ─────────────────────────────────

const repeatedWordsRoute = createRoute({
  tags: ['AI Tools'],
  method: 'post',
  path: '/ai/tools/greek-room/repeated-words',
  middleware: [
    authenticateUser,
    requirePermission(PERMISSIONS.AI_TOOLS_USE),
    requireAiToolsAccess(),
  ] as const,
  request: {
    body: jsonContent(
      RepeatedWordsRequestSchema,
      'Verses to scan for repeated words, plus the project unit (milestone) they belong to'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      RepeatedWordsResponseSchema,
      'Repeated-words check completed (terminal status)'
    ),
    [HttpStatusCodes.ACCEPTED]: jsonContent(
      RepeatedWordsResponseSchema,
      'Repeated-words check accepted; poll for result (queued/running)'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      createMessageObjectSchema('Bad Request'),
      'Invalid request body (including a missing project_unit_id)'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Missing AI_TOOLS_USE permission'
    ),
    [HttpStatusCodes.NOT_FOUND]: jsonContent(
      createMessageObjectSchema('Project not found'),
      'Unknown project unit, or the caller cannot read its project'
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(errorResponseSchema, 'Upstream fluent-ai error'),
  },
  summary: 'Run the Greek-Room repeated-words check',
  description:
    'Proxies a repeated-words check to fluent-ai. fluent-api resolves `project_unit_id` to its ' +
    'owning project, authorizes against it, and builds the upstream payload with that ' +
    "project's id and name (decision D8, amended by #420); `lang_code`, `lang_name` and " +
    '`verses` are forwarded as sent. The full ToolJobResponse envelope is returned on ' +
    'success (decision D9). ' +
    'Returns 200 for terminal statuses (completed/failed/cancelled) and 202 for queued/running.',
});

server.openapi(repeatedWordsRoute, async (c) => {
  const body = c.req.valid('json');
  // Set by requireAiToolsAccess — the project resolved from body.project_unit_id.
  const project = c.get('project')!;
  const result = await callRepeatedWords(body, project);

  if (!result.ok) {
    return c.json(
      { error: result.error.message, code: result.error.code } as never,
      getHttpStatus(result.error) as never
    );
  }

  const envelope = result.data;
  // Terminal statuses return 200; non-terminal (queued/running) return 202 so
  // the (future) polling client knows to keep polling. D9 / §8.3 / §10.3.
  const status =
    envelope.status === 'completed' ||
    envelope.status === 'failed' ||
    envelope.status === 'cancelled'
      ? HttpStatusCodes.OK
      : HttpStatusCodes.ACCEPTED;

  return c.json(envelope as never, status as never);
});
