import { z } from '@hono/zod-openapi';

import env from '@/env';

const groundingSchema = z.object({
  resourceLanguage: z.string().min(1).max(20),
  instruction: z.string().max(500).default(''),
});
const languageSchema = z.object({
  displayName: z.string().min(1).max(100),
  projectLanguageCodes: z.array(z.string().min(1).max(20)).min(1).max(20),
  responseLanguageHint: z.string().min(1).max(20),
  guidanceSlug: z.string().min(1).max(64).optional(),
  defaultGrounding: z.string().min(1).max(20),
  grounding: z.record(groundingSchema),
});
const languagesSchema = z.record(languageSchema);
const CODE_PATTERN = /^[a-z][\w-]{0,19}$/i;
const BT_RESPONSE_LANGUAGE_PATTERN = /^[a-z]{2}$/;
const VERSION_PATTERN = /^[a-z0-9][\w.-]{0,63}$/i;

const DEFAULTS = {
  operationVersion: 'passage-briefing-v1',
  profileVersion: 'fluent-profile-v1',
  resourcePolicyVersion: 'fluent-resource-policy-v1',
  cacheEpoch: '1',
  connectMs: 10_000,
  idleMs: 45_000,
  totalMs: 180_000,
  maxInputBytes: 48_000,
  maxOutputBytes: 96_000,
  maxFrameBytes: 1_048_576,
} as const;

interface AssistantEnvInput {
  BT_SERVANT_BASE_URL?: string;
  BT_SERVANT_ENGINE_KEY?: string;
  BT_SERVANT_ORG?: string;
  ASSISTANT_LANGUAGES_JSON?: string;
  ASSISTANT_OPERATION_VERSION?: string;
  ASSISTANT_PROFILE_VERSION?: string;
  ASSISTANT_RESOURCE_POLICY_VERSION?: string;
  ASSISTANT_CACHE_EPOCH?: string;
  ASSISTANT_CONNECT_TIMEOUT_MS?: string;
  ASSISTANT_IDLE_TIMEOUT_MS?: string;
  ASSISTANT_TOTAL_TIMEOUT_MS?: string;
  ASSISTANT_MAX_INPUT_BYTES?: string;
  ASSISTANT_MAX_OUTPUT_BYTES?: string;
  ASSISTANT_MAX_FRAME_BYTES?: string;
}

export type AssistantLanguage = z.infer<typeof languageSchema>;
type AssistantLanguages = z.infer<typeof languagesSchema>;
type GroundingChoice = 'configured' | 'output_language' | 'english';

export function validateAssistantLanguages(raw: unknown): AssistantLanguages | null {
  const parsed = languagesSchema.safeParse(raw);
  if (!parsed.success || !Object.hasOwn(parsed.data, 'en')) return null;
  if (Object.keys(parsed.data).length > 100) return null;
  const projectCodes = new Set<string>();
  for (const [outputCode, entry] of Object.entries(parsed.data)) {
    if (Object.keys(entry.grounding).length > 8) return null;
    if (
      !CODE_PATTERN.test(outputCode) ||
      !BT_RESPONSE_LANGUAGE_PATTERN.test(entry.responseLanguageHint) ||
      !CODE_PATTERN.test(entry.defaultGrounding) ||
      (entry.guidanceSlug !== undefined && !CODE_PATTERN.test(entry.guidanceSlug)) ||
      Object.entries(entry.grounding).some(
        ([profile, resolution]) =>
          !CODE_PATTERN.test(profile) || !CODE_PATTERN.test(resolution.resourceLanguage)
      )
    )
      return null;
    if (!Object.hasOwn(entry.grounding, entry.defaultGrounding)) return null;
    for (const code of entry.projectLanguageCodes.map((value) => value.toLowerCase())) {
      if (!CODE_PATTERN.test(code)) return null;
      if (projectCodes.has(code)) return null;
      projectCodes.add(code);
    }
    if (
      !Object.hasOwn(entry.grounding, entry.responseLanguageHint) ||
      !Object.hasOwn(entry.grounding, 'en')
    )
      return null;
  }
  return parsed.data;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  maximum: number
): number | null {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : null;
}

export function parseAssistantConfig(input: AssistantEnvInput) {
  const normalize = (value: string | undefined) => value?.trim() || undefined;
  const trimmed: AssistantEnvInput = {
    BT_SERVANT_BASE_URL: normalize(input.BT_SERVANT_BASE_URL),
    BT_SERVANT_ENGINE_KEY: normalize(input.BT_SERVANT_ENGINE_KEY),
    BT_SERVANT_ORG: normalize(input.BT_SERVANT_ORG),
    ASSISTANT_LANGUAGES_JSON: normalize(input.ASSISTANT_LANGUAGES_JSON),
    ASSISTANT_OPERATION_VERSION: normalize(input.ASSISTANT_OPERATION_VERSION),
    ASSISTANT_PROFILE_VERSION: normalize(input.ASSISTANT_PROFILE_VERSION),
    ASSISTANT_RESOURCE_POLICY_VERSION: normalize(input.ASSISTANT_RESOURCE_POLICY_VERSION),
    ASSISTANT_CACHE_EPOCH: normalize(input.ASSISTANT_CACHE_EPOCH),
    ASSISTANT_CONNECT_TIMEOUT_MS: normalize(input.ASSISTANT_CONNECT_TIMEOUT_MS),
    ASSISTANT_IDLE_TIMEOUT_MS: normalize(input.ASSISTANT_IDLE_TIMEOUT_MS),
    ASSISTANT_TOTAL_TIMEOUT_MS: normalize(input.ASSISTANT_TOTAL_TIMEOUT_MS),
    ASSISTANT_MAX_INPUT_BYTES: normalize(input.ASSISTANT_MAX_INPUT_BYTES),
    ASSISTANT_MAX_OUTPUT_BYTES: normalize(input.ASSISTANT_MAX_OUTPUT_BYTES),
    ASSISTANT_MAX_FRAME_BYTES: normalize(input.ASSISTANT_MAX_FRAME_BYTES),
  };
  if (
    !trimmed.BT_SERVANT_BASE_URL ||
    !trimmed.BT_SERVANT_ENGINE_KEY ||
    !trimmed.BT_SERVANT_ORG ||
    !trimmed.ASSISTANT_LANGUAGES_JSON
  )
    return null;
  let baseUrl: URL;
  try {
    baseUrl = new URL(trimmed.BT_SERVANT_BASE_URL);
    if (!['http:', 'https:'].includes(baseUrl.protocol)) return null;
  } catch {
    return null;
  }
  if (!CODE_PATTERN.test(trimmed.BT_SERVANT_ORG) || trimmed.BT_SERVANT_ENGINE_KEY.length > 4096)
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed.ASSISTANT_LANGUAGES_JSON);
  } catch {
    return null;
  }
  const languages = validateAssistantLanguages(raw);
  if (!languages) return null;
  const connectMs = positiveInteger(
    trimmed.ASSISTANT_CONNECT_TIMEOUT_MS,
    DEFAULTS.connectMs,
    60_000
  );
  const idleMs = positiveInteger(trimmed.ASSISTANT_IDLE_TIMEOUT_MS, DEFAULTS.idleMs, 180_000);
  const totalMs = positiveInteger(trimmed.ASSISTANT_TOTAL_TIMEOUT_MS, DEFAULTS.totalMs, 600_000);
  const maxInputBytes = positiveInteger(
    trimmed.ASSISTANT_MAX_INPUT_BYTES,
    DEFAULTS.maxInputBytes,
    1_048_576
  );
  const maxOutputBytes = positiveInteger(
    trimmed.ASSISTANT_MAX_OUTPUT_BYTES,
    DEFAULTS.maxOutputBytes,
    1_048_576
  );
  const maxFrameBytes = positiveInteger(
    trimmed.ASSISTANT_MAX_FRAME_BYTES,
    DEFAULTS.maxFrameBytes,
    8_388_608
  );
  if ([connectMs, idleMs, totalMs, maxInputBytes, maxOutputBytes, maxFrameBytes].includes(null))
    return null;
  if (connectMs! > totalMs! || idleMs! > totalMs!) return null;
  const operationVersion = trimmed.ASSISTANT_OPERATION_VERSION ?? DEFAULTS.operationVersion;
  const profileVersion = trimmed.ASSISTANT_PROFILE_VERSION ?? DEFAULTS.profileVersion;
  const resourcePolicyVersion =
    trimmed.ASSISTANT_RESOURCE_POLICY_VERSION ?? DEFAULTS.resourcePolicyVersion;
  const cacheEpoch = trimmed.ASSISTANT_CACHE_EPOCH ?? DEFAULTS.cacheEpoch;
  if (
    !VERSION_PATTERN.test(operationVersion) ||
    !VERSION_PATTERN.test(profileVersion) ||
    !VERSION_PATTERN.test(resourcePolicyVersion) ||
    !VERSION_PATTERN.test(cacheEpoch)
  )
    return null;
  return {
    baseUrl: baseUrl.toString().replace(/\/$/, ''),
    engineKey: trimmed.BT_SERVANT_ENGINE_KEY,
    org: trimmed.BT_SERVANT_ORG,
    languages,
    operationVersion,
    profileVersion,
    resourcePolicyVersion,
    cacheEpoch,
    budgets: {
      connectMs: connectMs!,
      idleMs: idleMs!,
      totalMs: totalMs!,
      maxInputBytes: maxInputBytes!,
      maxOutputBytes: maxOutputBytes!,
      maxFrameBytes: maxFrameBytes!,
    },
  };
}

export function loadAssistantConfig() {
  return parseAssistantConfig(env);
}

export function resolveGrounding(
  language: AssistantLanguage,
  choice: GroundingChoice = 'configured'
) {
  const key =
    choice === 'configured'
      ? language.defaultGrounding
      : choice === 'english'
        ? 'en'
        : language.responseLanguageHint;
  return Object.hasOwn(language.grounding, key) ? language.grounding[key] : null;
}

export function publicLanguages(config: NonNullable<ReturnType<typeof loadAssistantConfig>>) {
  return Object.entries(config.languages).map(([code, value]) => ({
    code,
    displayName: value.displayName,
  }));
}

export function selectOutputLanguage(
  config: NonNullable<ReturnType<typeof loadAssistantConfig>>,
  projectLanguageCode: string | null,
  persisted?: string
): string {
  if (persisted && Object.hasOwn(config.languages, persisted)) return persisted;
  const normalized = projectLanguageCode?.toLowerCase();
  return (
    Object.entries(config.languages).find(([, value]) =>
      value.projectLanguageCodes.some((code) => code.toLowerCase() === normalized)
    )?.[0] ?? 'en'
  );
}
