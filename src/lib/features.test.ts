import { describe, expect, it } from 'vitest';

import type env from '@/env';

import { declaredFeatureEnvKeys } from '@/env';

import { buildFeatures, FEATURE_PREFIX, FLAGS, wireFeatureKeys } from './features';

// A minimal env stand-in for buildFeatures(): only the fields the resolvers read
// matter. Cast through unknown so tests don't have to fabricate the whole env.
function makeEnv(overrides: Partial<Record<string, unknown>>): typeof env {
  return overrides as unknown as typeof env;
}

const AI_WIRED = { FLUENT_AI_URL: 'http://ai:8200', FLUENT_AI_KEY: 'k' };
const AI_UNWIRED = { FLUENT_AI_URL: '', FLUENT_AI_KEY: '' };

describe('buildFeatures', () => {
  it('honors an explicitly-set flag (true) regardless of AI wiring', () => {
    const features = buildFeatures(
      makeEnv({ ...AI_UNWIRED, EN_FEATURE_REPEATED_WORD_CHECK: true })
    );
    expect(features.repeatedWordCheck).toBe(true);
  });

  it('honors an explicitly-set flag (false) even when AI is wired', () => {
    const features = buildFeatures(makeEnv({ ...AI_WIRED, EN_FEATURE_REPEATED_WORD_CHECK: false }));
    expect(features.repeatedWordCheck).toBe(false);
  });

  it('derives repeatedWordCheck = true when unset and AI is wired', () => {
    const features = buildFeatures(makeEnv({ ...AI_WIRED }));
    expect(features.repeatedWordCheck).toBe(true);
  });

  it('derives repeatedWordCheck = false (safe default) when unset and AI is not wired', () => {
    const features = buildFeatures(makeEnv({ ...AI_UNWIRED }));
    expect(features.repeatedWordCheck).toBe(false);
  });

  it('treats a missing (undefined) AI url/key as not wired → safe-off default', () => {
    const features = buildFeatures(makeEnv({}));
    expect(features.repeatedWordCheck).toBe(false);
  });

  it('honors an explicitly-set aiSuggestions flag (true) regardless of AI wiring', () => {
    const features = buildFeatures(makeEnv({ ...AI_UNWIRED, EN_FEATURE_AI_SUGGESTIONS: true }));
    expect(features.aiSuggestions).toBe(true);
  });

  it('derives aiSuggestions = true when unset and AI is wired', () => {
    const features = buildFeatures(makeEnv({ ...AI_WIRED }));
    expect(features.aiSuggestions).toBe(true);
  });

  it('derives aiSuggestions = false (safe default) when unset and AI is not wired', () => {
    const features = buildFeatures(makeEnv({ ...AI_UNWIRED }));
    expect(features.aiSuggestions).toBe(false);
  });

  it('returns exactly the known flag keys — no extras, none missing', () => {
    const features = buildFeatures(makeEnv({ ...AI_WIRED }));
    expect(Object.keys(features).sort()).toEqual([...wireFeatureKeys].sort());
  });
});

/**
 * Keep-in-sync drift guard. A feature flag is declared in three places that use
 * two vocabularies:
 *   1. env schema — `EN_FEATURE_*` keys           (operator's catalog)
 *   2. FLAGS registry — camelCase wire keys        (env↔wire mapping)
 *   3. OpenAPI schema — camelCase wire keys         (programmer's catalog)
 * They are the same set under the deterministic prefix-strip + camelCase rule.
 * This test asserts all three project to the SAME set, so adding a flag in only
 * one place fails here (in every direction) — the belt to the compiler's
 * suspenders (the `satisfies` in features.ts already hard-guards FLAGS↔wire).
 */
describe('feature flag declarations stay in sync (drift guard)', () => {
  // The prefix-strip + camelCase rule, inlined because only this test needs it.
  const toWireKey = (envKey: string): string =>
    envKey
      .slice(FEATURE_PREFIX.length)
      .toLowerCase()
      .replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());

  const envSideWireKeys = [...declaredFeatureEnvKeys].map(toWireKey).sort();
  const registryKeys = Object.keys(FLAGS).sort();
  const wireKeys = [...wireFeatureKeys].sort();

  const explain = [
    'Feature-flag declarations are out of sync. Every flag must appear in all THREE:',
    `  • env schema (EN_FEATURE_*) → wire keys: [${envSideWireKeys.join(', ')}]`,
    `  • FLAGS registry keys:                   [${registryKeys.join(', ')}]`,
    `  • OpenAPI featuresSchema keys:           [${wireKeys.join(', ')}]`,
    'To add a flag: add EN_FEATURE_<NAME> in src/env.ts (+ .env.example), a FLAGS',
    'entry in src/lib/features.ts, and a property in featuresSchema. To remove one,',
    'delete it from all three.',
  ].join('\n');

  it('env schema flags (camelCased) match the FLAGS registry keys', () => {
    expect(registryKeys, explain).toEqual(envSideWireKeys);
  });

  it('registry keys (FLAGS) match the OpenAPI featuresSchema keys', () => {
    expect(wireKeys, explain).toEqual(registryKeys);
  });

  it('env schema flags (camelCased) match the OpenAPI featuresSchema keys', () => {
    expect(wireKeys, explain).toEqual(envSideWireKeys);
  });

  it('every FLAGS entry points at a declared EN_FEATURE_* env var', () => {
    const declared = new Set(declaredFeatureEnvKeys);
    for (const wireKey of Object.keys(FLAGS)) {
      const envKey = FLAGS[wireKey as keyof typeof FLAGS].env;
      expect(declared.has(envKey), `${envKey} (backing ${wireKey}) is not declared in env.ts`).toBe(
        true
      );
    }
  });
});
