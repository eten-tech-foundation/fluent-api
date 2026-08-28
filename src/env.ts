import { z } from '@hono/zod-openapi';
import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import path from 'node:path';

expand(
  config({
    path: path.resolve(process.cwd(), process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
  })
);

// ── Env boolean parser ────────────────────────────────────────────────────────
// A string→boolean parser for env vars, behaviourally equivalent to Zod v4's
// z.stringbool(). We do NOT use z.coerce.boolean(): coercion follows JS
// truthiness, so the string "false" would parse to `true` and silently INVERT a
// safe-off default — exactly the wrong failure mode for a feature flag whose job
// is to keep AI UI hidden. We also can't reach z.stringbool() here: it lives in
// the Zod v4 API (the `zod/v4` subpath in zod 3.25.x), whereas @hono/zod-openapi
// binds the classic (v3-style) `z` used throughout this schema. So we implement
// the same contract explicitly on the classic `z`: accept the usual env
// spellings (true/false, 1/0, yes/no, on/off — case-insensitive), reject
// anything else, and preserve the unset case via .optional() so a derived
// default can still apply.
const TRUTHY = new Set(['true', '1', 'yes', 'on']);
const FALSY = new Set(['false', '0', 'no', 'off']);
const envBool = () =>
  z.string().transform((v, ctx): boolean | undefined => {
    const normalized = v.trim().toLowerCase();
    // Treat a blank / whitespace-only value as UNSET (undefined) rather than a
    // parse error: dotenv loads a bare `EN_FEATURE_REPEATED_WORD_CHECK=` line
    // (exactly how .env.example documents it) as the empty string "", and
    // .optional() alone does NOT catch that — the transform still runs on "".
    // Without this, copying .env.example verbatim would fail EnvSchema.safeParse
    // at boot. Returning undefined lets the derived default (AI-wiring) apply,
    // which is the intended "flag not explicitly set" behaviour.
    if (normalized === '') return undefined;
    if (TRUTHY.has(normalized)) return true;
    if (FALSY.has(normalized)) return false;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Expected a boolean-ish string (true/false, 1/0, yes/no, on/off), received "${v}"`,
    });
    return z.NEVER;
  });

const EnvBaseSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(9999),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
    .optional(),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_COOKIE_DOMAIN: z.string().default('.fluent.bible'),
  BETTER_AUTH_SESSION_EXPIRY_SECONDS: z.coerce.number().default(60 * 60 * 24 * 7), // 7 days
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string(),

  // ── Cloudflare R2 storage (S3-compatible) ──────────────────────────────
  // One set of credentials serves both consumers: async USFM exports and verse
  // audio recordings. All three are optional — when any is unset the async
  // export endpoints and the verse-audio routes respond 503 (the sync export
  // path is unaffected), and the worker refuses export jobs. Both buckets MUST
  // be created in the EU jurisdiction so files at rest stay in the EU (GDPR) —
  // see .env.example.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  // Jurisdiction segment of the R2 endpoint
  // ({account}.{jurisdiction}.r2.cloudflarestorage.com). 'eu' pins data at rest
  // to the EU (GDPR); 'default' uses the un-pinned global endpoint.
  R2_JURISDICTION: z.string().default('eu'),
  // Overrides the derived R2 endpoint. Only for pointing local dev at an
  // S3-compatible server (MinIO); leave unset against real R2 so the
  // jurisdiction stays pinned by the derived host.
  R2_ENDPOINT: z.string().url().optional(),
  // Bucket dedicated to USFM exports — kept separate from the audio bucket
  // because deleteExpiredExports sweeps and deletes every object in it older
  // than the export TTL. Audio uses a different reclaim path (orphans +
  // superseded takes). Deliberately NOT defaulted; required alongside the
  // credentials — see requireExplicitR2Buckets.
  R2_EXPORTS_BUCKET: z.string().optional(),
  // Bucket dedicated to verse audio recordings. Active takes are retained;
  // superseded takes on clean units are pruned by the reclaim sweep.
  // Also not defaulted — see requireExplicitR2Buckets.
  R2_AUDIO_BUCKET: z.string().optional(),
  // How often orphaned storage objects and superseded takes are reclaimed.
  AUDIO_RECLAIM_INTERVAL_MS: z.coerce.number().int().positive().default(3600000),
  // How long a storage row / superseded take is left alone before the sweep may
  // reclaim it. An upload claims its row before writing the object, so it briefly
  // looks orphaned; this keeps the sweep off anything that young. The same window
  // is the retention cap for non-active takes on a clean (non-conflicted) unit.
  AUDIO_RECLAIM_GRACE_MS: z.coerce.number().int().positive().default(3600000),

  EMAIL_SERVICE_API_KEY: z.string(),
  EMAIL_SERVICE_DOMAIN: z.string(),
  EMAIL_SERVICE_SENDER: z.string(),
  FRONTEND_URL: z.string(),

  // AI suggestion tunables
  AI_ACTIVATION_THRESHOLD_VERSES: z.coerce.number().int().positive().default(500),
  AI_INITIAL_QUEUE_COUNT: z.coerce.number().int().positive().default(3),
  AI_DEFAULT_LOOKAHEAD: z.coerce.number().int().positive().default(3),
  AI_MAX_REQUESTED_BIBLE_TEXT_IDS: z.coerce.number().int().positive().default(200),
  AI_TRIGGER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // ── Rate limiting (#210) ──────────────────────────────────────────────
  // Knobs for the in-memory per-IP limiter (src/middlewares/rate-limit.ts).
  // Defaults preserve the values the limiter shipped with, so all four can
  // stay unset until the deployment topology changes.
  //
  // How many trailing x-forwarded-for entries were appended by proxies we
  // control. 1 = Azure App Service today (front-end appends the client IP as
  // the last entry). Raise per extra trusted LB layer; 0 = no proxy in front,
  // ignore the header entirely and key on the TCP socket address instead.
  RATE_LIMIT_TRUSTED_HOPS: z.coerce.number().int().min(0).default(1),
  // Hard cap on tracked client buckets per process (memory bound).
  RATE_LIMIT_MAX_BUCKETS: z.coerce.number().int().positive().default(10_000),
  // Per-route limits: bulk bible-texts reads (see bible-texts.route.ts).
  RATE_LIMIT_BULK_TEXTS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_BULK_TEXTS_MAX: z.coerce.number().int().positive().default(20),

  // ── Fluent-AI integration ──────────────────────────────────────────
  // Base URL of the fluent-ai service (no trailing slash, no path suffix).
  // Ecosystem mode (via fluent-platform): http://ai:8200 — standalone: http://localhost:8200
  FLUENT_AI_URL: z.string().url(),
  // Shared API key for calling fluent-ai (matches a row in fluent-ai's ai_api_keys table).
  FLUENT_AI_KEY: z.string().min(1),
  // Path prefix that fluent-ai mounts its routers under, BETWEEN the base URL and
  // the per-tool path.
  FLUENT_AI_API_PREFIX: z.string().default(''),

  // Key used to authenticate incoming webhook callbacks from fluent-ai
  AI_INBOUND_SERVICE_KEY: z.string().min(1),

  // ── Aquifer (translation resources: TN / TQ / Images) ─────────────────
  // Base URL of the Aquifer API (no trailing slash). Defaults to production.
  AQUIFER_API_URL: z.string().url().default('https://api.aquifer.bible'),
  // Server-held Aquifer API key — never expose to mobile/web clients.
  // Optional like R2 credentials: unset/blank boots fine; translation-resources
  // routes return AQUIFER_SERVICE_UNAVAILABLE (502) until a key is configured.
  AQUIFER_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    }),

  // ── API.Bible (DBL) Integration ──────────────────────────────────────
  DBL_API_BASE_URL: z.string().url().default('https://rest.api.bible/v1'),
  DBL_API_KEY: z.string().optional().default(''),
  // Per-request timeout (ms) for calls to the DBL/API.Bible client.
  DBL_API_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  // ── Feature flags (EN_FEATURE_*) ──────────────────────────────────────
  // One flat boolean env var per optional feature, under a dedicated
  // EN_FEATURE_ prefix. Each flag is declared explicitly here (proposal D2) so
  // this schema stays the OPERATOR's catalog of known flags and validates their
  // values — a fixed z.object strips unknown keys, so an undeclared EN_FEATURE_*
  // var would be dropped before it could be read.
  //
  // ⚠️ A flag lives in THREE places that must stay in sync — adding/removing one
  //    here means updating the other two (a test in
  //    src/lib/features.test.ts fails on drift, in both directions):
  //      1. this env-schema line          (operator's catalog + validation)
  //      2. the FLAGS registry            (src/lib/features.ts — env↔wire mapping + default)
  //      3. the OpenAPI response schema   (src/routes/config.route.ts — programmer's catalog)
  //    …plus a line in .env.example.
  //
  // Repeated Word Check — the one AI-dependent feature today. Left optional so
  // its unset default can be derived from AI wiring by buildFeatures(): true
  // only when FLUENT_AI_URL + FLUENT_AI_KEY are both wired, otherwise false —
  // so forgetting to set it in an AI-less environment yields the safe answer
  // (off). Parsed via envBool() (NOT z.coerce.boolean(), which would turn the
  // string "false" into true and invert the safe default).
  EN_FEATURE_REPEATED_WORD_CHECK: envBool().optional(),
  // AI Suggestions — same contract as EN_FEATURE_REPEATED_WORD_CHECK above:
  // unset derives from AI wiring (aiIsWired), safe-off when AI isn't wired.
  EN_FEATURE_AI_SUGGESTIONS: envBool().optional(),
});

const R2_BUCKET_KEYS = ['R2_EXPORTS_BUCKET', 'R2_AUDIO_BUCKET'] as const;

/**
 * Neither bucket var may carry a hardcoded default.
 *
 * R2 credentials are ACCOUNT-level, so environments pointed at the same R2
 * account are separated by nothing but their bucket names. With a default, an
 * environment whose deploy config forgot `R2_AUDIO_BUCKET` would boot happily on
 * the fallback name — and because audio object keys are deterministic
 * (`unit-{id}/text-{id}`), two such environments would read and OVERWRITE each
 * other's recordings rather than miss and 404. Silent and destructive, instead of
 * loud and safe.
 *
 * So once any R2 credential is present, both buckets must be named explicitly.
 * A missing one fails env validation at boot — a static config error caught
 * before the server starts, unlike an unreachable bucket at runtime, which stays
 * non-fatal by design (see verifyBlobStorageOnBoot / isAudioStorageAvailable).
 */
function requireExplicitR2Buckets(
  value: z.infer<typeof EnvBaseSchema>,
  ctx: z.RefinementCtx
): void {
  const anyCredential = Boolean(
    value.R2_ACCOUNT_ID || value.R2_ACCESS_KEY_ID || value.R2_SECRET_ACCESS_KEY
  );
  if (!anyCredential) return;

  for (const key of R2_BUCKET_KEYS) {
    if (value[key]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `${key} is required when R2 credentials are set — name the bucket this environment owns explicitly; there is no default to inherit, because two environments sharing one bucket would overwrite each other's objects`,
    });
  }
}

/**
 * The full env contract. Exported so src/env.test.ts can exercise the R2 rule
 * above: parsing the real environment happens once at module load below, which
 * leaves no other seam to test a cross-field rule through.
 */
export const EnvSchema = EnvBaseSchema.superRefine(requireExplicitR2Buckets);

export type env = z.infer<typeof EnvSchema>;

/**
 * The `EN_FEATURE_*` keys DECLARED in the schema (regardless of whether they are
 * set in the current environment — Zod strips unset optionals from the parsed
 * object, so this reads the schema shape, not `process.env`). This is the
 * env-side half of the feature-flag drift check in src/lib/features.test.ts.
 */
export const declaredFeatureEnvKeys: string[] = Object.keys(EnvBaseSchema.shape).filter((k) =>
  k.startsWith('EN_FEATURE_')
);

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error('❌ Invalid env:');
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
