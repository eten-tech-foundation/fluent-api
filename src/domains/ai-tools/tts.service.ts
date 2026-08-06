import type { Result } from '@/lib/types';

import env from '@/env';
import { buildToolUrl } from '@/lib/services/fluent-ai/fluent-ai.client';
import { ErrorCode, ErrorMessages } from '@/lib/types';

import type { TtsGenerateRequest, TtsGenerateResponse } from './tts.types';

import { TtsGenerateResponseSchema } from './tts.types';

/**
 * Source-TTS upstream calls (proposal §7.1–§7.3).
 *
 * ── Why this does NOT use `callFluentAi()` ───────────────────────────────────
 * The shared helper is bound to fluent-ai's `ToolJobResponse` envelope: it
 * requires `job_id`/`tool`/`status`/`created_at`, and — decisively — it
 * RECONSTRUCTS the response object field by field before returning it. Any field
 * outside that envelope (such as `audioUrl`) would be silently dropped. The TTS
 * contract is not a tool-job: `generate` returns `{ audioUrl }` synchronously
 * with no job envelope at all. So this module makes its own thin call and keeps
 * the parsed body intact (§12.2 "passes the response body through unmodified").
 * The one thing it DOES reuse is `buildToolUrl`, so the FLUENT_AI_API_PREFIX
 * behaviour cannot drift between the two call paths.
 *
 * ── The mirrored route tail is load-bearing (§7.1) ───────────────────────────
 * fluent-ai's tails are `tts/generate` and `tts/audio/{hash}.wav`; fluent-api
 * exposes them as `/ai/tts/generate` and `/ai/tts/audio/{hash}.wav`. Because
 * `audioUrl` is sibling-relative, the browser resolves it against the fluent-api
 * URL it actually called. If these two paths ever stop being siblings under one
 * prefix, resolution breaks — on BOTH services.
 */

/** Timeout for the (cheap, no-synthesis) generate call. */
const GENERATE_TIMEOUT_MS = 30_000;

function aiError(code: ErrorCode, detail?: string): Extract<Result<never>, { ok: false }> {
  const base = ErrorMessages[code];
  return { ok: false, error: { code, message: detail ? `${base}: ${detail}` : base } };
}

/**
 * `POST tts/generate` — authorize + record the synthesis recipe upstream.
 *
 * No audio is produced by this call (T8): fluent-ai writes an immutable request
 * sidecar and returns the `audioUrl`, and generation is deferred to the first
 * `get-audio`. That is why prefetching is nearly free and why this call is safe
 * to repeat — the sidecar PUT is conditional, so repeats are idempotent.
 */
export async function generateTtsAudio(
  request: TtsGenerateRequest,
  options?: { signal?: AbortSignal }
): Promise<Result<TtsGenerateResponse>> {
  const url = buildToolUrl('tts/generate');

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let signal: AbortSignal;
  if (options?.signal) {
    signal = options.signal;
  } else {
    const controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), GENERATE_TIMEOUT_MS);
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
      // Forwarded as validated: `voice`/`format`/`langCode`/`pacing` are relayed
      // untouched, and an omitted `format` STAYS omitted so fluent-ai resolves
      // TTS_DEFAULT_FORMAT before hashing (§7.1).
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      return aiError(
        ErrorCode.AI_SERVICE_UNAVAILABLE,
        `request timed out after ${GENERATE_TIMEOUT_MS}ms`
      );
    }
    const cause = error instanceof Error ? error.message : String(error);
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `fluent-ai unreachable (${cause})`);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const rawBody = await response.text();

  if (!response.ok) {
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `fluent-ai returned HTTP ${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return aiError(
      ErrorCode.AI_SERVICE_UNAVAILABLE,
      'malformed response from fluent-ai (body was not valid JSON)'
    );
  }

  // Validates that `audioUrl` is present without stripping anything else —
  // the schema is `.passthrough()` precisely so a field fluent-ai adds later
  // reaches the browser instead of dying here.
  const result = TtsGenerateResponseSchema.safeParse(parsed);
  if (!result.success) {
    return aiError(
      ErrorCode.AI_SERVICE_UNAVAILABLE,
      'malformed generate response from fluent-ai (missing audioUrl)'
    );
  }

  return { ok: true, data: result.data };
}

/**
 * `GET|HEAD tts/audio/{hash}.{ext}` — fetch the artifact for relay.
 *
 * Returns the RAW `Response` (not a `Result`) on purpose: the route's job is to
 * relay status, headers and an unread body stream, so anything this function
 * parsed or buffered would be damage. The two non-negotiables live here:
 *
 *  1. `redirect: 'manual'` — fluent-ai answers a 302 to the immutable public R2
 *     object once the artifact is compressed. Node's fetch default is
 *     `redirect: 'follow'`, which would make fluent-api quietly DOWNLOAD and
 *     re-stream those bytes: functional, but it two-hops immutable audio through
 *     the proxy and reopens the Range-consistency hazard the redirect design
 *     exists to eliminate (§7.3). This single option is the most breakable line
 *     in the phase — there is a test asserting the 302 is relayed, not followed.
 *
 *  2. NO timeout signal. A first listen is a live synthesis stream that stays
 *     open for the duration of the audio; a 30s cap like `generate`'s would
 *     guillotine a long verse mid-sentence. Cancellation instead follows the
 *     CLIENT: the caller passes the inbound request's signal, so a user pressing
 *     stop propagates upstream. (This is local-safe — aborting a read never
 *     cancels the detached upstream generation, by design (T21).)
 */
export async function fetchTtsAudio(
  hash: string,
  extension: string,
  options: { method: 'GET' | 'HEAD'; signal?: AbortSignal }
): Promise<Result<Response>> {
  const url = buildToolUrl(`tts/audio/${hash}.${extension}`);

  try {
    const response = await fetch(url, {
      method: options.method,
      headers: { 'X-API-Key': env.FLUENT_AI_KEY },
      redirect: 'manual',
      signal: options.signal,
    });
    return { ok: true, data: response };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      // The CLIENT went away (stop pressed, page navigated). Not an upstream
      // fault, so it must not be reported as one.
      return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, 'audio request aborted');
    }
    const cause = error instanceof Error ? error.message : String(error);
    return aiError(ErrorCode.AI_SERVICE_UNAVAILABLE, `fluent-ai unreachable (${cause})`);
  }
}
