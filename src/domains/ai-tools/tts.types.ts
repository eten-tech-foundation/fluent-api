import { z } from '@hono/zod-openapi';

/**
 * Wire schemas for the Source-TTS proxy routes (proposal §7.1).
 *
 * ── snake_case here, exactly like its ai-tools sibling ───────────────────────
 * `ai-tools.types.ts` uses snake_case because it mirrors Greek-Room's Python
 * field names verbatim (decision D8), and fluent-web then mirrors them again.
 * TTS follows the same rule for the same reason: fluent-ai is a Python service,
 * so `lang_code` and `audio_url` travel verbatim from fluent-ai through this
 * proxy to the browser. §7.1 originally specified camelCase; that was corrected
 * during implementation (see the 2026-08-11 note in the proposal) because
 * camelCase would have required this proxy to TRANSLATE the response body, which
 * §12.2 forbids it from touching at all — and because two opposite conventions
 * at one service boundary is the worse outcome. Keep these two files aligned.
 *
 * Note the seam this does NOT cross: fluent-web's `features/tts/tts.types.ts`
 * stays camelCase, because those types hold DERIVED values (its `audioUrl` is
 * the absolutized URL, not the raw reference sent here) and serve a future
 * browser-local engine that has no wire at all.
 *
 * ── The backend knows nothing about scripture (T6) ───────────────────────────
 * There is no verse, chapter, project or bible in this contract — only text.
 * That is what lets a future caller speak instructions or resource notes with no
 * backend change, and what makes the artifact cache shareable across projects.
 */

/**
 * Compressed formats the fluent-ai compression tail can produce (§7.1).
 *
 * OPTIONAL on purpose: when omitted, fluent-ai resolves `TTS_DEFAULT_FORMAT`
 * BEFORE hashing, so "omitted" never exists past the API edge. fluent-web omits
 * it unless the browser cannot play Opus. fluent-api does not default it —
 * defaulting here would move an admin-controlled choice into the proxy and
 * silently split the artifact cache.
 */
export const TtsFormatSchema = z.enum(['ogg-opus', 'mp3']);

export const TtsGenerateRequestSchema = z
  .object({
    // Non-empty is enforced here so a trivially-invalid request never costs a
    // round-trip to fluent-ai. There is no `.max()`, and no maximum anywhere in
    // this service: proposal §7.1 makes length fluent-ai's business, not this
    // proxy's. It owns the tripwire, the configured number and the
    // `TTS_TEXT_TOO_LONG` rejection, so there is exactly one value and it cannot
    // drift. Do not re-add a cap here "just to be safe" — a second number that
    // must agree with the first is the bug this arrangement removes.
    text: z.string().min(1).openapi({
      description:
        'Exact visible text to recite. fluent-ai rejects text beyond its configured maximum.',
      example: 'In the beginning God created the heavens and the earth.',
    }),
    voice: z.string().min(1).optional().openapi({
      description:
        'Requested logical/provider voice. v1 fluent-web omits it; the server default applies.',
    }),
    format: TtsFormatSchema.optional().openapi({
      description:
        'Compressed format to produce. Omitted by default so fluent-ai resolves TTS_DEFAULT_FORMAT.',
    }),
    lang_code: z.string().min(1).optional().openapi({
      description: 'ISO 639-3 language hint, sent whenever the caller knows it (T18). Advisory.',
      example: 'eng',
    }),
  })
  // There is no `pacing` field. T11 reserved one for a future synthesis-time
  // cadence option; it was removed on 2026-08-11, before anything shipped,
  // because it had no defined values, no UI, no provider parameter and no
  // testable behavior — fluent-ai could only have guessed at what to do with a
  // non-null value. Since `.strict()` below makes the ADDITIVE direction the
  // safe one, a real pacing field costs one coordinated change whenever someone
  // actually implements cadence. Playback speed remains client `playbackRate`.
  //
  // `.strict()` — an unknown field is a client bug worth surfacing as
  // TTS_INVALID_REQUEST rather than silently dropping. This is safe against
  // forward evolution because a NEW field would be added here (and to
  // fluent-web) in the same change; it is the additive direction that matters.
  .strict();

export type TtsGenerateRequest = z.infer<typeof TtsGenerateRequestSchema>;

/**
 * `generate` success body (§7.1).
 *
 * `audio_url` has two intentional forms. A cold artifact is sibling-relative
 * (e.g. `audio/9f2ac1d4….wav`) so playback enters the authenticated recovery
 * route; a warm compressed artifact may be an absolute R2 URL to skip a proxy
 * hop. fluent-api passes either through byte-identically. The cold form requires
 * `/ai/tts/generate` and `/ai/tts/audio/{hash}.wav` to remain siblings.
 *
 * There is deliberately NO duration field: a streaming first listen has no
 * knowable duration, and once compressed the container header carries the exact
 * value for free (T22 / §6.2). Do not add it back.
 */
export const TtsGenerateResponseSchema = z
  .object({
    audio_url: z.string().min(1).openapi({
      description:
        'Cold sibling-relative or warm absolute URL reference to the audio; resolve it against the response URL.',
      example: 'audio/9f2ac1d47bfe3a5c8e1d0b6a4f7c2e91.wav',
    }),
  })
  // NOT `.strict()`, and this asymmetry with the request schema is deliberate:
  // fluent-ai owns the response shape, so an added field must survive the proxy
  // untouched (§7.1/§12.2 "passes the response body through unmodified") instead
  // of being stripped by fluent-api's validator. Passthrough keeps unknown keys.
  .passthrough();

export type TtsGenerateResponse = z.infer<typeof TtsGenerateResponseSchema>;
