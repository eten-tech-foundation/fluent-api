import { z } from '@hono/zod-openapi';

import type env from '@/env';

/**
 * Feature flags — the env-sourced projection published by `GET /config/features`.
 *
 * The env is the single source of truth (see the `EN_FEATURE_*` block in
 * {@link file://../env.ts}); this module derives the read-only map that
 * fluent-web consumes to decide which optional UI to render. There is NO
 * server-side enforcement here (proposal D5) — this only *publishes* which
 * optional features are on; it does not gate the AI request path.
 *
 * ── Two audiences, one fact, kept in sync ──────────────────────────────────
 * A feature flag is written in two vocabularies:
 *   • the OPERATOR reads the `EN_FEATURE_*` env var (declared literally in the
 *     Zod schema in env.ts, so the schema stays their catalog);
 *   • the API/UI PROGRAMMER reads the camelCase wire key in the OpenAPI doc for
 *     `GET /config/features`.
 * The two are the same fact under a deterministic naming rule. Rather than make
 * either side infer the other, both are declared, and drift between them is
 * caught (see features.test.ts, which asserts the env-side and wire-side flag
 * sets are equal in BOTH directions). This `FLAGS` registry is the single place
 * that ties an env var to its wire key and its unset-default; `buildFeatures()`
 * iterates it (no string-prefix sweep, no casts) and the wire type is derived
 * from it, so the OpenAPI schema and the registry cannot drift (a compile-time
 * `satisfies` in config.route.ts enforces that half).
 *
 * Adding a feature = declare `EN_FEATURE_<NAME>` in env.ts + a line in
 * `.env.example` + one entry here + one property in the OpenAPI schema. The
 * drift test fails if any of those fall out of step.
 */

/** The `EN_FEATURE_` prefix that marks a schema key as a feature flag. */
export const FEATURE_PREFIX = 'EN_FEATURE_';

type Env = typeof env;

/** Resolves an unset (optional) flag to its safe default from the full env. */
type DefaultResolver = (e: Env) => boolean;

interface FlagDefinition {
  /** The env var backing this flag. Typed as a real key of the parsed env, so a
   *  typo or an unbacked flag is a compile error (registry → env schema link). */
  readonly env: Extract<keyof Env, `${typeof FEATURE_PREFIX}${string}`>;
  /** The value published when the env var is unset (undefined). */
  readonly default: DefaultResolver;
}

/**
 * True when fluent-ai is actually wired (both URL and key present, non-empty).
 * Used to derive the safe-off default of AI-dependent flags left unset — so
 * forgetting the flag in an AI-less environment yields the safe answer (off).
 */
const aiIsWired: DefaultResolver = (e) => Boolean(e.FLUENT_AI_URL && e.FLUENT_AI_KEY);

/**
 * The flag registry. Keys are the camelCase WIRE keys (what the API publishes
 * and fluent-web reads); each value ties that wire key to its backing env var
 * and its unset-default.
 *
 * ⚠️ A flag lives in THREE places that must stay in sync — adding/removing an
 *    entry here means updating the other two (the drift test below fails, in
 *    both directions, if they diverge):
 *      1. the env-schema line          (src/env.ts — operator's catalog + validation)
 *      2. this FLAGS registry          (env↔wire mapping + default)
 *      3. the OpenAPI response schema  (src/routes/config.route.ts — programmer's catalog)
 *    …plus a line in .env.example.
 */
export const FLAGS = {
  // Repeated Word Check — the one AI-dependent feature today. Defaults to
  // whether AI is wired when EN_FEATURE_REPEATED_WORD_CHECK is unset (D2/§4.2).
  repeatedWordCheck: { env: 'EN_FEATURE_REPEATED_WORD_CHECK', default: aiIsWired },
} as const satisfies Record<string, FlagDefinition>;

/** The set of known wire keys, e.g. `'repeatedWordCheck'`. */
export type FeatureName = keyof typeof FLAGS;

/** The published feature map: every known flag, always present. */
export type Features = Record<FeatureName, boolean>;

/**
 * Build the published feature map from the parsed, validated env.
 *
 * For each registry entry: an explicitly set env var uses its parsed boolean
 * value; an unset (optional → `undefined`) var falls back to the entry's
 * `default` resolver. No prefix sweep and no cast — the registry keys ARE the
 * wire keys, so the returned object is exactly `Features`.
 */
export function buildFeatures(e: Env): Features {
  const entries = (Object.keys(FLAGS) as FeatureName[]).map((wireKey) => {
    const def = FLAGS[wireKey];
    const raw = e[def.env] as boolean | undefined;
    const value = typeof raw === 'boolean' ? raw : def.default(e);
    return [wireKey, value] as const;
  });

  return Object.fromEntries(entries) as Features;
}

// ── The published wire schema (programmer's catalog) ────────────────────────
// Named, boolean properties so the OpenAPI doc for GET /config/features lists
// each flag explicitly (a programmer reading the docs never has to infer the
// key from the env var). Consumed by src/routes/config.route.ts.
//
// The `satisfies z.ZodType<Features>` below is the compile-time half of the
// keep-in-sync guarantee: it forces this schema's inferred type to be assignable
// to Features (= the FLAGS keys), so a property named here that isn't a known
// flag, or a wrong value type, is a `tsc` error. The reverse direction (a FLAGS
// key with no property here) and the env↔wire directions are covered by the
// drift test in features.test.ts.
export const featuresSchema = z
  .object({
    repeatedWordCheck: z.boolean().openapi({ example: false }),
  })
  .openapi('Features') satisfies z.ZodType<Features>;

/** The wire-side flag keys — the wire half of the drift check in features.test.ts. */
export const wireFeatureKeys: string[] = Object.keys(featuresSchema.shape);
