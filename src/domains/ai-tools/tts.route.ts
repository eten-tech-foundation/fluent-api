import type { Context } from 'hono';

import { createRoute, z } from '@hono/zod-openapi';
import * as HttpStatusCodes from 'stoker/http-status-codes';
import { jsonContent } from 'stoker/openapi/helpers';
import { createMessageObjectSchema } from 'stoker/openapi/schemas';

import type { AppEnv } from '@/server/context.types';

import { PERMISSIONS } from '@/lib/permissions';
import { getHttpStatus } from '@/lib/types';
import { authenticateUser, requirePermission } from '@/middlewares/role-auth';
import { server } from '@/server/server';

import { fetchTtsAudio, generateTtsAudio } from './tts.service';
import { TtsGenerateRequestSchema, TtsGenerateResponseSchema } from './tts.types';

/**
 * Source-TTS proxy routes (proposal §7.1–§7.3, T5/T10/T13/T14).
 *
 * fluent-api is the authenticated FRONT DOOR and nothing more: it holds no
 * Google key, no audio bytes, and no database rows for this feature. It
 * authorizes, enforces the length tripwire, and relays.
 *
 * ⚠️ The two paths below MUST remain siblings under one prefix, mirroring
 * fluent-ai's own tails (`tts/generate`, `tts/audio/{hash}.wav`), because
 * `audio_url` is sibling-relative and the browser resolves it against the URL it
 * called. This is a stated contract requirement (§7.1), not a naming style.
 */

// Same error body shape the sibling AI proxy uses (D9 / §10.3).
const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string(),
  details: z.unknown().optional(),
});

// ─── Fluent error codes owned by this route ───────────────────────────────────
// A TTS-specific 400 named in §7.1. It is a string literal rather than an
// addition to the shared `ErrorCode` enum because that enum drives a
// code→HTTP-status map, and this is a plain 400 raised (and shaped) at this one
// call site; adding it there would imply a domain-wide meaning it does not have.
//
// `TTS_TEXT_TOO_LONG` used to live here too. It moved to fluent-ai with the
// limit itself (T27, 2026-08-11): this proxy validates SHAPE, not size.
const TTS_INVALID_REQUEST = 'TTS_INVALID_REQUEST';

/**
 * Turns a Zod validation failure into `400 TTS_INVALID_REQUEST` (§7.1).
 *
 * Without this hook, @hono/zod-openapi's default handler answers with its own
 * `{ success: false, error: ZodError }` envelope — a shape the frontend cannot
 * read and a code the proposal does not define. Applied to ALL THREE routes, so
 * a malformed body and a malformed audio filename fail the same documented way.
 *
 * Note this is deliberately a PER-ROUTE hook, not a `defaultHook` on the shared
 * server: `src/server/server.ts` installs none today, so every existing route
 * inherits the raw zod-openapi shape. Fixing that globally would change the
 * error contract of every endpoint in the API — far outside this feature's
 * blast radius. (`src/lib/create-app.ts` does pass stoker's defaultHook, but
 * nothing imports it.)
 */
const ttsValidationHook = (
  result: { success: true } | { success: false; error: z.ZodError },
  c: Context
): Response | undefined => {
  if (result.success) return undefined;
  return c.json(
    {
      error: 'The TTS request was malformed',
      code: TTS_INVALID_REQUEST,
      details: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    HttpStatusCodes.BAD_REQUEST
  );
};

// The generated `Hook` type is parameterized by each route's own parsed-target
// types, which this shared hook ignores by design — it only ever acts on the
// failure branch, which is identical for all three. Widened ONCE here so the
// registrations below stay cast-free.
const validationHook = ttsValidationHook as never;

// ─── POST /ai/tts/generate ────────────────────────────────────────────────────

const ttsGenerateRoute = createRoute({
  tags: ['AI Tools'],
  method: 'post',
  path: '/ai/tts/generate',
  // TTS_USE is a view-level alias (`project:view`) — hearing follows seeing
  // (T13 / §11.1). Gating on edit-level permission would wrongly deny a reviewer
  // who can legitimately read the passage.
  middleware: [authenticateUser, requirePermission(PERMISSIONS.TTS_USE)] as const,
  request: {
    body: jsonContent(
      TtsGenerateRequestSchema,
      'Text to synthesize. Backend-agnostic: no verse, chapter or project identity (T6).'
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      TtsGenerateResponseSchema,
      'Synthesis authorized. `audio_url` is a sibling-relative reference — resolve it against the request URL, do not concatenate a base.'
    ),
    [HttpStatusCodes.BAD_REQUEST]: jsonContent(
      errorResponseSchema,
      'TTS_INVALID_REQUEST — the body was malformed or `text` was empty. Length is fluent-ai’s to judge (T27).'
    ),
    [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
      createMessageObjectSchema('Unauthorized'),
      'Authentication required'
    ),
    [HttpStatusCodes.FORBIDDEN]: jsonContent(
      createMessageObjectSchema('Forbidden'),
      'Missing TTS_USE permission'
    ),
    [HttpStatusCodes.BAD_GATEWAY]: jsonContent(
      errorResponseSchema,
      'fluent-ai unreachable or returned an unusable response'
    ),
  },
  summary: 'Authorize text-to-speech for a piece of text',
  description:
    'Proxies to fluent-ai. NO audio is synthesized by this call (T8): fluent-ai records an ' +
    'immutable request sidecar and returns the audio URL, and generation happens lazily on the ' +
    'first GET of that URL — so prefetching is nearly free and repeat calls are idempotent. ' +
    'The response body is passed through unmodified; in particular `audio_url` is never rewritten. ' +
    'There is deliberately no duration field (§6.2).',
});

server.openapi(
  ttsGenerateRoute,
  async (c) => {
    const body = c.req.valid('json');

    // No length check here on purpose (T27, operator decision 2026-08-11): the
    // tripwire lives in fluent-ai, which holds the only copy of the number. Two
    // services with a same-named limit that must agree is a drift bug waiting to
    // happen — set them differently and the effective limit silently becomes
    // whichever one nobody edited. The cost is that an oversized body travels
    // one internal hop before rejection, which is nil: this route has already
    // parsed and buffered it to validate shape, and fluent-ai rejects before any
    // provider call, so nothing is billed.
    const result = await generateTtsAudio(body);

    if (!result.ok) {
      return c.json(
        { error: result.error.message, code: result.error.code } as never,
        getHttpStatus(result.error) as never
      );
    }

    // Passed through verbatim (§7.1/§12.2): the sibling-relative `audio_url` only
    // resolves correctly if fluent-api leaves it exactly as fluent-ai wrote it.
    // Cast because the schema is `.passthrough()` — the extra keys it is built to
    // preserve are by definition not statically known.
    return c.json(result.data as never, HttpStatusCodes.OK);
  },
  validationHook
);

// ─── GET|HEAD /ai/tts/audio/{file} ────────────────────────────────────────────

/**
 * `{file}` is `{hash}.{ext}` — an extension SWAP, not a format request (§7.2):
 * `/{hash}.wav` streams during the generation era, and once the compressed
 * artifact exists the very same path answers a 302 to the immutable object. The
 * hash already pins the format, so the extension here is not a content
 * negotiation knob.
 *
 * Validated tightly (hex hash + known extension) so this path cannot be used to
 * smuggle arbitrary segments into the upstream URL.
 */
const audioFileSchema = z
  .string()
  .regex(/^[a-f0-9]{16,128}\.(?:wav|ogg|mp3)$/, 'Expected {hash}.wav, {hash}.ogg or {hash}.mp3')
  .openapi({
    param: { name: 'file', in: 'path' },
    example: '9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.wav',
  });

const audioResponses = {
  [HttpStatusCodes.OK]: {
    description:
      'Audio bytes. During the generation era this is a chunked, live-synthesized WAV stream with no Content-Length and no Range support.',
    content: { 'audio/wav': { schema: z.string().openapi({ format: 'binary' }) } },
  },
  [HttpStatusCodes.MOVED_TEMPORARILY]: {
    description:
      'The compressed artifact exists: redirect to the immutable public object. 302 (never 301) — the .wav URL means "whatever era this artifact is in right now", and a cached permanent redirect would freeze that. fluent-api relays this without following it.',
  },
  [HttpStatusCodes.UNAUTHORIZED]: jsonContent(
    createMessageObjectSchema('Unauthorized'),
    'Authentication required'
  ),
  [HttpStatusCodes.FORBIDDEN]: jsonContent(
    createMessageObjectSchema('Forbidden'),
    'Missing TTS_USE permission'
  ),
  [HttpStatusCodes.NOT_FOUND]: {
    description:
      'No request sidecar for this hash — it was never authorized through generate (or the artifact is gone). Self-healing: the client re-calls generate and retries.',
  },
  [HttpStatusCodes.SERVICE_UNAVAILABLE]: {
    description:
      "fluent-ai's RAM admission gate refused a NEW generation; carries Retry-After. Relayed verbatim — fluent-api never manufactures this status.",
  },
  [HttpStatusCodes.BAD_GATEWAY]: jsonContent(errorResponseSchema, 'fluent-ai unreachable'),
} as const;

const ttsAudioRoute = createRoute({
  tags: ['AI Tools'],
  method: 'get',
  path: '/ai/tts/audio/{file}',
  middleware: [authenticateUser, requirePermission(PERMISSIONS.TTS_USE)] as const,
  request: { params: z.object({ file: audioFileSchema }) },
  responses: audioResponses,
  summary: 'Stream or redirect to synthesized audio',
  description:
    "Relays fluent-ai's serving waterfall. Carries no body validation and no length tripwire — " +
    'admission control lives in fluent-ai (§7.2). Session-cookie auth is present but not ' +
    'load-bearing: the unguessable content-addressed URL is the real capability (T10).',
});

/**
 * HEAD is registered EXPLICITLY, and it is not optional politeness: fluent-web's
 * recovery ladder classifies every playback failure by HEAD-probing this exact
 * URL (`probeClipUrl` in features/tts/engines/serverTtsEngine.ts) and branches on
 * 503 vs 404 vs 302 vs 200. Without HEAD the client's entire failure-recovery
 * path collapses into "unknown error". Relying on a framework to synthesize HEAD
 * from GET would also risk a buffered body being produced upstream just to be
 * discarded, so the method is forwarded as HEAD to fluent-ai too.
 */
const ttsAudioHeadRoute = createRoute({
  ...ttsAudioRoute,
  method: 'head',
  summary: 'Probe synthesized audio (status/headers only)',
  description:
    "Same waterfall as GET, headers only. This is fluent-web's failure classifier: 503 ⇒ wait " +
    'Retry-After, 302 ⇒ the compressed artifact now exists, 404 ⇒ re-run generate, 200 ⇒ still ' +
    'streaming.',
});

/**
 * Headers relayed from fluent-ai, allowlisted rather than copied wholesale.
 *
 * Wholesale copying would forward hop-by-hop and identity headers
 * (`transfer-encoding`, `connection`, `content-encoding`, `server`) that belong
 * to the upstream connection and corrupt or leak when re-emitted on a different
 * one. Everything the client's behaviour actually depends on is here:
 *  - `location`      — the 302 target (useless if dropped);
 *  - `retry-after`   — drives the admission backoff the client waits out;
 *  - `content-type`  — chooses the media pipeline;
 *  - `cache-control` — governs local replay of a completed stream;
 *  - `etag` / `accept-ranges` / `content-range` / `content-length` /
 *    `last-modified` — the compressed era's seek + revalidate story.
 */
const RELAYED_HEADERS = [
  'location',
  'retry-after',
  'content-type',
  'cache-control',
  'etag',
  'accept-ranges',
  'content-range',
  'content-length',
  'last-modified',
] as const;

function relayHeaders(upstream: Response): Headers {
  const headers = new Headers();
  for (const name of RELAYED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Shared GET/HEAD handler.
 *
 * The body is handed over as an UNREAD stream (`upstream.body`) — never awaited,
 * never buffered (§7.3/§12.2). Reading it here would hold a whole first-listen
 * WAV in fluent-api's memory and delay first audio until synthesis finished,
 * defeating live streaming.
 */
async function handleAudioRelay(c: Context<AppEnv>, file: string): Promise<Response> {
  // Read from the REQUEST, never from the registration this handler belongs to.
  // Hono answers a HEAD request from the GET route when both are registered, so a
  // hardcoded 'GET' here would forward HEAD probes upstream as full GETs — making
  // fluent-ai synthesize an entire clip only for the body to be thrown away, and
  // silently defeating the cheap probe fluent-web's failure classifier depends on.
  // (Caught by test: "forwards the method as HEAD rather than fetching the whole body".)
  const method = c.req.method === 'HEAD' ? 'HEAD' : 'GET';
  const separator = file.lastIndexOf('.');
  const hash = file.slice(0, separator);
  const extension = file.slice(separator + 1);

  const result = await fetchTtsAudio(hash, extension, {
    method,
    // Tie the upstream read to the client's connection so a stop/navigation
    // stops pulling bytes. Aborting is local-only — no cancel is sent upstream
    // and the detached generation continues for other listeners (T21).
    signal: c.req.raw.signal,
  });

  if (!result.ok) {
    // Mapped to 502 via the shared code→status table. Note what is NOT here:
    // fluent-api never manufactures a 503. That status is meaningful — it means
    // fluent-ai's RAM budget refused a new generation — and it reaches the client
    // only by being relayed below.
    return c.json(
      { error: result.error.message, code: result.error.code } as never,
      getHttpStatus(result.error) as never
    );
  }

  const upstream = result.data;
  const headers = relayHeaders(upstream);

  // A 304/204 (or any HEAD) has no body by definition; passing a stream for
  // those is invalid. Otherwise relay the stream as-is.
  const body =
    method === 'HEAD' || upstream.status === 204 || upstream.status === 304 ? null : upstream.body;

  // Constructed directly rather than via `c.body(...)`: the status here is
  // whatever fluent-ai answered (200/302/404/503/206…), which cannot be narrowed
  // to this route's declared union without casting all three arguments.
  return new Response(body, { status: upstream.status, headers });
}

server.openapi(
  ttsAudioRoute,
  async (c) => {
    const { file } = c.req.valid('param');
    return handleAudioRelay(c, file) as never;
  },
  validationHook
);

// Registered so HEAD is DOCUMENTED in the OpenAPI spec; at runtime Hono may serve
// HEAD from the GET route above, which is why the handler reads the method off the
// request instead of trusting which registration it arrived through.
server.openapi(
  ttsAudioHeadRoute,
  async (c) => {
    const { file } = c.req.valid('param');
    return handleAudioRelay(c, file) as never;
  },
  validationHook
);

export { ttsAudioHeadRoute, ttsAudioRoute, ttsGenerateRoute };
