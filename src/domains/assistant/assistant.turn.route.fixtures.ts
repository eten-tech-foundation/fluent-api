import type { PassageContext } from './assistant.repository';

import { resolveTurnContext } from './assistant.context';
import {
  createBriefingGenerationInput,
  generationInputFingerprint,
} from './assistant.generation-input';
import { SHARED_ASSISTANT_ACTIONS } from './assistant.prompt';
import { parseReceiptKey, TurnReceipts } from './assistant.receipts';
import { config, user, validBody } from './assistant.route.test-fixtures';
import { assistantTurnRequestSchema } from './assistant.turn.types';

export const turnRouteKey = parseReceiptKey({
  ASSISTANT_RECEIPT_KEY_ID: 'test',
  ASSISTANT_RECEIPT_KEY_HEX: '02'.repeat(32),
})!;

export const turnRoutePassage: PassageContext = {
  sourceBible: 'Canonical Source',
  sourceLanguageCode: 'eng',
  verses: [{ bookCode: 'MAT', chapter: 4, verse: 25, text: 'server source' }],
  integritySource: {
    organizationId: 1,
    sourceBibleId: 9,
    provider: 'dbl',
    externalId: null,
    pericopeSetId: 3,
    membership: { number: '12', section: null },
    members: [{ id: 1, chapter: 4, verse: 25 }],
  },
};

export function turnRouteContext() {
  return resolveTurnContext({
    projectId: 7,
    passage: turnRoutePassage,
    config,
    outputLanguage: 'en',
    resourceLanguage: 'en',
    groundingInstruction: config.languages.en.grounding.en.instruction,
  })!;
}

export function turnRouteRequest() {
  const receipts = new TurnReceipts(turnRouteKey, user.id, turnRouteContext());
  const question = 'Why?';
  const prefix = {
    markdown: `briefing\n\n{{fluent:v1:suggested_question|${question}}}`,
    sequence: 1,
    complete: true,
  };
  const briefingFingerprint = generationInputFingerprint(
    createBriefingGenerationInput({
      operationVersion: config.operationVersion,
      language: config.languages.en,
      resourceLanguage: 'en',
      groundingInstruction: config.languages.en.grounding.en.instruction,
      sourceBible: turnRoutePassage.sourceBible,
      sourceLanguageCode: turnRoutePassage.sourceLanguageCode,
      verses: turnRoutePassage.verses,
      actions: SHARED_ASSISTANT_ACTIONS,
      maxOutputBytes: config.budgets.maxOutputBytes,
      cacheEpoch: config.cacheEpoch,
    })
  );
  return assistantTurnRequestSchema.parse({
    protocol: 'fluent-turn-v1',
    ...validBody,
    grounding: 'configured',
    contextReceipt: receipts.contextReceipt(),
    briefing: {
      ...prefix,
      receipt: receipts.prefix(receipts.briefingBinding(briefingFingerprint), prefix),
    },
    turns: [],
    submission: {
      kind: 'new',
      turnId: 'turn',
      attemptId: 'attempt',
      input: { text: question, origin: 'suggested_question' },
    },
  });
}
