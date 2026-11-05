import type { loadAssistantConfig } from './assistant.config';
import type { PassageContext } from './assistant.repository';

import { WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import { integrityDigest } from './assistant.receipts';
import { turnContextSchema } from './assistant.turn.types';

/** Shared authorized project/resource scope, not actor identity. Guards remain mandatory. */
export function resolveTurnContext(input: {
  projectId: number;
  passage: PassageContext;
  config: NonNullable<ReturnType<typeof loadAssistantConfig>>;
  outputLanguage: string;
  resourceLanguage: string;
  groundingInstruction: string;
}) {
  const { passage, config } = input;
  if (!passage.integritySource) return null;
  const language = config.languages[input.outputLanguage];
  const parsed = turnContextSchema.safeParse({
    projectId: input.projectId,
    sourceBible: passage.sourceBible,
    sourceLanguageCode: passage.sourceLanguageCode,
    verses: passage.verses,
    outputLanguage: input.outputLanguage,
    responseLanguageHint: language.responseLanguageHint,
    guidanceSlug: language.guidanceSlug ?? 'default',
    resourceLanguage: input.resourceLanguage,
    groundingInstruction: input.groundingInstruction,
    authorizationScope: integrityDigest('authorization-scope', {
      projectId: input.projectId,
      organizationId: passage.integritySource.organizationId,
      sourceBibleId: passage.integritySource.sourceBibleId,
    }),
    sourceRevision: integrityDigest('source-revision', passage.integritySource),
    resourceRevision: integrityDigest('resource-revision', {
      briefingVersion: config.operationVersion,
      widgetVersion: WIDGET_CONTRACT_VERSION,
    }),
    operationVersion: 'passage-turn-v1',
    profileVersion: config.profileVersion,
    resourcePolicyVersion: config.resourcePolicyVersion,
    epoch: config.cacheEpoch,
  });
  return parsed.success ? parsed.data : null;
}
