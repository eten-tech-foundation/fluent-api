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

const EnvSchema = z.object({
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

  // ── Async USFM export storage (Cloudflare R2, S3-compatible) ───────
  // Optional: when the three R2 credentials are unset the async export
  // endpoints respond 503 and the worker refuses export jobs (the sync export
  // path is unaffected). Credential var names are shared with the audio-record
  // R2 integration for org consistency. The exports bucket MUST be created in
  // the EU jurisdiction so files at rest stay in the EU (GDPR) — see
  // .env.example. Local dev: MinIO or a real R2 dev bucket.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  // Jurisdiction segment of the R2 endpoint
  // ({account}.{jurisdiction}.r2.cloudflarestorage.com). 'eu' pins data at rest
  // to the EU (GDPR); 'default' uses the un-pinned global endpoint.
  R2_JURISDICTION: z.string().default('eu'),
  // Bucket dedicated to USFM exports — kept separate from other R2 buckets
  // because deleteExpiredExports sweeps and deletes every object in it older
  // than the export TTL.
  R2_EXPORTS_BUCKET: z.string().default('usfm-exports'),

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

export type env = z.infer<typeof EnvSchema>;

/**
 * The `EN_FEATURE_*` keys DECLARED in the schema (regardless of whether they are
 * set in the current environment — Zod strips unset optionals from the parsed
 * object, so this reads the schema shape, not `process.env`). This is the
 * env-side half of the feature-flag drift check in src/lib/features.test.ts.
 */
export const declaredFeatureEnvKeys: string[] = Object.keys(EnvSchema.shape).filter((k) =>
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
