import type { BtHistoryPair } from './assistant.client';
import type { AssistantLanguage } from './assistant.config';
import type { SourceVerse } from './assistant.prompt';
import type { AssistantActions } from './assistant.types';

import { buildBriefingPrompt, WIDGET_CONTRACT_VERSION } from './assistant.prompt';
import { integrityDigest } from './assistant.receipts';

export interface AssistantOutputConstraints {
  contractVersion: string;
  maxBytes: number;
  completeIsAuthoritative: true;
  requireNonBlank: true;
}

/** Exact provider-visible input plus the explicit output/cache compatibility envelope. */
export interface AssistantGenerationInput {
  artifactKind: 'passage_briefing' | 'passage_turn';
  message: string;
  history: BtHistoryPair[];
  responseLanguageHint: string;
  outputConstraints: AssistantOutputConstraints;
  cacheEpoch: string;
}

export function generationInputFingerprint(input: AssistantGenerationInput): string {
  return integrityDigest('assistant-generation-input-v1', input);
}

export function createBriefingGenerationInput(input: {
  operationVersion: string;
  language: AssistantLanguage;
  resourceLanguage: string;
  groundingInstruction: string;
  sourceBible: string;
  sourceLanguageCode: string;
  verses: SourceVerse[];
  actions?: AssistantActions;
  maxOutputBytes: number;
  cacheEpoch: string;
}): AssistantGenerationInput {
  return {
    artifactKind: 'passage_briefing',
    message: buildBriefingPrompt(input),
    history: [],
    responseLanguageHint: input.language.responseLanguageHint,
    outputConstraints: {
      contractVersion: WIDGET_CONTRACT_VERSION,
      maxBytes: input.maxOutputBytes,
      completeIsAuthoritative: true,
      requireNonBlank: true,
    },
    cacheEpoch: input.cacheEpoch,
  };
}

export function providerRequest(
  input: AssistantGenerationInput,
  userId: string
): {
  userId: string;
  message: string;
  history: BtHistoryPair[];
  responseLanguageHint: string;
} {
  return {
    userId,
    message: input.message,
    history: input.history,
    responseLanguageHint: input.responseLanguageHint,
  };
}
