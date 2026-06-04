import { z } from '@hono/zod-openapi';

import type { Result } from '@/lib/types';

import env from '@/env';
import { ErrorCode, ErrorMessages } from '@/lib/types';

import type { JobStatus, ToolJobResponse } from './fluent-ai.types';

const DEFAULT_TIMEOUT_MS = 30_000;

const JOB_STATUS_VALUES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly JobStatus[];

/**
 * Envelope schema used to validate the structural shape of every fluent-ai
 * response. The `result` field is validated separately against the caller's
 * per-tool schema (and only when status === 'completed'), so it is `unknown`
 * here.
 *
 * snake_case mirrors the fluent-ai wire contract verbatim (decision D8 / §8.1).
 */
const toolJobEnvelopeSchema = z.object({
  job_id: z.string(),
  tool: z.string(),
  status: z.enum(JOB_STATUS_VALUES),
  result: z.unknown().nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
  created_at: z.string(),
  completed_at: z.string().nullable(),
});

interface CallFluentAiOptions {
  /** Honored if the caller wants their own timeout / cancellation. */
  signal?: AbortSignal;
  /** Default 30_000ms. Ignored when an explicit `signal` is supplied. */
  timeoutMs?: number;
}

/**
 * Build an AppError. fluent-api's `AppError` is intentionally minimal
 * (`{ message, code }`), so any diagnostic context (HTTP status, upstream
 * code, parse failures) is appended to the human-readable message rather than
 * stuffed into a non-existent `details` field. The route layer logs the full
 * envelope separately.
 */
function aiError(code: ErrorCode, detail?: string): Extract<Result<never>, { ok: false }> {
  const base = ErrorMessages[code];
  return {
    ok: false,
    error: { code, message: detail ? `${base}: ${detail}` : base },
  };
}

/**
 * Shared client for calling a fluent-ai tool endpoint.
 *
 * Behavior (see §7):
 *  - POSTs to `${FLUENT_AI_URL}/api/v1/${toolPath}` with `X-API-Key` and a JSON body.
 *  - Honors a caller-supplied `AbortSignal`, otherwise applies a default 30s timeout.
 *  - On 2xx, parses the body as a `ToolJobResponse` and (only when
 *    `status === 'completed'`) validates `result` against `resultSchema`.
 *  - Returns the FULL envelope on success — callers decide how to unwrap it.
 *  - Translates every failure mode to a `Result.err` per the §10.2 mapping table.
 *
 * What it deliberately does NOT do (§7.3): no polling, no caching, no retries.
 */
export async function callFluentAi<TReq, TResult>(
  toolPath: string,
  body: TReq,
  resultSchema: z.ZodType<TResult>,
  options?: CallFluentAiOptions
): Promise<Result<ToolJobResponse<TResult>>> {
  const url = `${env.FLUENT_AI_URL}/api/v1/${toolPath}`;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Use the caller's signal if provided; otherwise derive a timeout signal.
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal;
  if (options?.signal) {
    signal = options.signal;
  } else {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    signal = controller.signal;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.FLUENT_AI_KEY,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `request timed out after ${timeoutMs}ms`);
    }
    const cause = error instanceof Error ? error.message : String(error);
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `fluent-ai unreachable (${cause})`);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  // Read the body once as text so we can parse it ourselves (fluent-ai always
  // responds with JSON on success).
  const rawBody = await response.text();

  if (!response.ok) {
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `fluent-ai returned HTTP ${response.status}`);
  }

  // Parse + structurally validate the envelope.
  const parsed = safeJsonParse(rawBody);
  if (parsed === undefined) {
    return aiError(
      ErrorCode.AI_SERVICE_UNAVAILABLE,
      'malformed response from fluent-ai (body was not valid JSON)'
    );
  }

  const envelopeResult = toolJobEnvelopeSchema.safeParse(parsed);
  if (!envelopeResult.success) {
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, 'malformed response envelope from fluent-ai');
  }

  const envelope = envelopeResult.data;

  // Terminal failure / cancellation: the dependency is up but the tool refused.
  if (envelope.status === 'failed' || envelope.status === 'cancelled') {
    const upstream = envelope.error?.message ?? envelope.status;
    return aiError(ErrorCode.AI_TOOL_EXECUTION_FAILED, upstream);
  }

  // Validate the result payload only for completed jobs; for queued/running the
  // result is null and must not be validated.
  let validatedResult: TResult | null = null;
  if (envelope.status === 'completed') {
    const resultParse = resultSchema.safeParse(envelope.result);
    if (!resultParse.success) {
      return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, 'malformed result payload from fluent-ai');
    }
    validatedResult = resultParse.data;
  }

  return {
    ok: true,
    data: {
      job_id: envelope.job_id,
      tool: envelope.tool,
      status: envelope.status,
      result: validatedResult,
      error: envelope.error,
      created_at: envelope.created_at,
      completed_at: envelope.completed_at,
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
