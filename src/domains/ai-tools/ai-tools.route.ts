import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import { logger } from '@/lib/logger';
import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

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
  middleware: [authenticateUser, requirePermission(PERMISSIONS.AI_TOOLS_USE)] as const,
  request: {
    body: jsonContent(
      RepeatedWordsRequestSchema,
      'Verses to scan for repeated words, forwarded verbatim to fluent-ai'
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
      'Invalid request body'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Missing AI_TOOLS_USE permission'
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(errorResponseSchema, 'Upstream fluent-ai error'),
  },
  summary: 'Run the Greek-Room repeated-words check',
  description:
    'Proxies a repeated-words check to fluent-ai. The request body is forwarded verbatim ' +
    '(decision D8) and the full ToolJobResponse envelope is returned on success (decision D9). ' +
    'Returns 200 for terminal statuses (completed/failed/cancelled) and 202 for queued/running.',
});

server.openapi(repeatedWordsRoute, async (c) => {
  const body = c.req.valid('json');

  // TEMP DIAGNOSTIC (BUG: legitimate not working) — remove before PR.
  // Logs the lang_code/lang_name the web client sent so we can confirm
  // greek-room is keyed on the ISO code ("eng") and not a display name/blank.
  // NOTE: dev logger is plain pino — signature is (mergeObject, message), so
  // the object MUST come first or it is silently dropped.
  logger.info(
    {
      lang_code: (body as { lang_code?: unknown }).lang_code,
      lang_name: (body as { lang_name?: unknown }).lang_name,
      project_id: (body as { project_id?: unknown }).project_id,
      verseCount: Array.isArray((body as { verses?: unknown[] }).verses)
        ? (body as { verses: unknown[] }).verses.length
        : 0,
    },
    '[RW-DIAG] inbound repeated-words request'
  );

  const result = await callRepeatedWords(body);

  // TEMP DIAGNOSTIC (BUG: legitimate not working) — remove before PR.
  // Logs each finding's repeated_word + legitimate flag returned by fluent-ai,
  // so we can see whether greek-room itself marked it legitimate.
  if (result.ok) {
    const resultData = (
      result.data as {
        result?: { lang_code?: unknown; findings?: Array<Record<string, unknown>> };
      }
    ).result;
    const findings = resultData?.findings ?? [];
    logger.info(
      {
        status: (result.data as { status?: unknown }).status,
        // lang_code echoed back by greek-room — compare against the inbound one.
        echoed_lang_code: resultData?.lang_code,
        findings: findings.map((f) => ({
          repeated_word: f.repeated_word,
          legitimate: f.legitimate,
          snt_id: f.snt_id,
        })),
      },
      '[RW-DIAG] fluent-ai response'
    );
  } else {
    logger.warn(
      { code: result.error.code, message: result.error.message },
      '[RW-DIAG] fluent-ai error'
    );
  }

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
