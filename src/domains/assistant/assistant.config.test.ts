import { describe, expect, it } from 'vitest';

import { EnvSchema } from '@/env';

import {
  loadAssistantConfig,
  parseAssistantConfig,
  resolveGrounding,
  selectOutputLanguage,
  validateAssistantLanguages,
} from './assistant.config';

const rawLanguages = {
  en: {
    displayName: 'English',
    projectLanguageCodes: ['eng'],
    responseLanguageHint: 'en',
    guidanceSlug: 'default',
    defaultGrounding: 'en',
    grounding: { en: { resourceLanguage: 'en', instruction: 'Use English resources.' } },
  },
  hi: {
    displayName: 'हिन्दी',
    projectLanguageCodes: ['hin'],
    responseLanguageHint: 'hi',
    guidanceSlug: 'default',
    defaultGrounding: 'hi',
    grounding: {
      hi: { resourceLanguage: 'hi', instruction: 'Use Hindi resources.' },
      en: { resourceLanguage: 'en', instruction: 'Use English resources, answer in Hindi.' },
    },
  },
};
const wiredEnv = {
  BT_SERVANT_BASE_URL: 'https://bt.example.test/',
  BT_SERVANT_ENGINE_KEY: 'fixture-credential',
  BT_SERVANT_ORG: 'fluent',
  ASSISTANT_LANGUAGES_JSON: JSON.stringify(rawLanguages),
};

function config(languages = validateAssistantLanguages(rawLanguages)!) {
  return {
    baseUrl: 'https://bt.invalid',
    engineKey: 'fixture-only',
    org: 'fluent',
    languages,
    operationVersion: 'v1',
    profileVersion: 'profile-v1',
    resourcePolicyVersion: 'resources-v1',
    cacheEpoch: '1',
    budgets: {
      connectMs: 1,
      idleMs: 1,
      totalMs: 1,
      maxInputBytes: 1,
      maxOutputBytes: 1,
      maxFrameBytes: 1,
    },
  };
}

describe('assistant language configuration', () => {
  it('loads safely from the real globally parsed env shape when unwired or validly wired', () => {
    const globalUnwired = EnvSchema.parse(process.env);
    expect(globalUnwired.PORT).toBeTypeOf('number');
    expect(() => parseAssistantConfig(globalUnwired)).not.toThrow();
    expect(parseAssistantConfig(globalUnwired)).toBeNull();
    expect(loadAssistantConfig()).toBeNull();

    const globalWired = EnvSchema.parse({ ...process.env, ...wiredEnv });
    expect(globalWired.PORT).toBeTypeOf('number');
    expect(parseAssistantConfig(globalWired)).toMatchObject({
      baseUrl: 'https://bt.example.test',
      org: 'fluent',
      budgets: { maxFrameBytes: 1_048_576 },
    });
  });

  it('keeps blank, incomplete, malformed URL, and malformed JSON wiring unavailable', () => {
    expect(parseAssistantConfig({})).toBeNull();
    expect(
      parseAssistantConfig({
        ...wiredEnv,
        BT_SERVANT_ENGINE_KEY: '   ',
      })
    ).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, BT_SERVANT_ORG: undefined })).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, BT_SERVANT_BASE_URL: 'not a URL' })).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, BT_SERVANT_BASE_URL: 'file:///tmp/bt' })).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, ASSISTANT_LANGUAGES_JSON: '{bad' })).toBeNull();
  });

  it('applies validated defaults only to complete wiring and rejects malformed budgets', () => {
    expect(parseAssistantConfig(wiredEnv)).toMatchObject({
      baseUrl: 'https://bt.example.test',
      operationVersion: 'passage-briefing-v1',
      profileVersion: 'fluent-profile-v1',
      resourcePolicyVersion: 'fluent-resource-policy-v1',
      cacheEpoch: '1',
      budgets: {
        connectMs: 10_000,
        idleMs: 45_000,
        totalMs: 180_000,
        maxInputBytes: 48_000,
        maxOutputBytes: 96_000,
        maxFrameBytes: 1_048_576,
      },
    });
    expect(parseAssistantConfig({ ...wiredEnv, ASSISTANT_CONNECT_TIMEOUT_MS: ' ' })).toMatchObject({
      budgets: { connectMs: 10_000 },
    });
    for (const value of ['0', '-1', '1.5', 'NaN', '999999999999']) {
      expect(parseAssistantConfig({ ...wiredEnv, ASSISTANT_CONNECT_TIMEOUT_MS: value })).toBeNull();
    }
    expect(
      parseAssistantConfig({ ...wiredEnv, ASSISTANT_OPERATION_VERSION: 'invalid version' })
    ).toBeNull();
    expect(
      parseAssistantConfig({ ...wiredEnv, ASSISTANT_PROFILE_VERSION: 'invalid version' })
    ).toBeNull();
    expect(
      parseAssistantConfig({ ...wiredEnv, ASSISTANT_RESOURCE_POLICY_VERSION: 'invalid version' })
    ).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, BT_SERVANT_ORG: 'invalid org' })).toBeNull();
    expect(parseAssistantConfig({ ...wiredEnv, ASSISTANT_TOTAL_TIMEOUT_MS: '5000' })).toBeNull();
  });

  it('selects an explicit project source match, English fallback, and stale fallback', () => {
    const value = config();
    expect(selectOutputLanguage(value, 'HIN')).toBe('hi');
    expect(selectOutputLanguage(value, 'fra')).toBe('en');
    expect(selectOutputLanguage(value, 'hin', 'removed')).toBe('hi');
    expect(selectOutputLanguage(value, 'hin', 'constructor')).toBe('hi');
    expect(selectOutputLanguage(value, 'hin', 'en')).toBe('en');
  });

  it('resolves configured H/H and bounded H/E grounding profiles', () => {
    const languages = validateAssistantLanguages(rawLanguages)!;
    expect(resolveGrounding(languages.hi)).toMatchObject({ resourceLanguage: 'hi' });
    expect(resolveGrounding(languages.hi, 'output_language')).toMatchObject({
      resourceLanguage: 'hi',
    });
    expect(resolveGrounding(languages.hi, 'english')).toMatchObject({ resourceLanguage: 'en' });
  });

  it('rejects absent English fallback and duplicate project-code matches', () => {
    expect(validateAssistantLanguages({ hi: rawLanguages.hi })).toBeNull();
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, projectLanguageCodes: ['ENG'] },
      })
    ).toBeNull();
    expect(
      parseAssistantConfig({ ...wiredEnv, ASSISTANT_MAX_FRAME_BYTES: '999999999' })
    ).toBeNull();
  });

  it('rejects unknown defaults and incomplete diagnostic resolutions', () => {
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, defaultGrounding: 'missing' },
      })
    ).toBeNull();
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, grounding: { hi: rawLanguages.hi.grounding.hi } },
      })
    ).toBeNull();
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, projectLanguageCodes: ['bad code'] },
      })
    ).toBeNull();
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, defaultGrounding: 'constructor' },
      })
    ).toBeNull();
  });

  it('never resolves an inherited grounding profile', () => {
    const languages = validateAssistantLanguages(rawLanguages)!;
    expect(resolveGrounding({ ...languages.hi, defaultGrounding: 'constructor' })).toBeNull();
  });

  it.each(['eng', 'EN', 'en_US'])('rejects invalid BT responseLanguageHint %s', (hint) => {
    expect(
      validateAssistantLanguages({
        ...rawLanguages,
        hi: { ...rawLanguages.hi, responseLanguageHint: hint },
      })
    ).toBeNull();
  });
});
