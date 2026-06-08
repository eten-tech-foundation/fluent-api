import type { ToolJobResponse } from '@/lib/services/fluent-ai/fluent-ai.types';
import type { Result } from '@/lib/types';

import { callFluentAi } from '@/lib/services/fluent-ai/fluent-ai.client';

import type { RepeatedWordsRequest, RepeatedWordsResult } from './ai-tools.types';

import { RepeatedWordsResultSchema } from './ai-tools.types';

/**
 * Per-tool wrapper for Greek-Room's "Repeated Words" check.
 *
 * Note the two distinct identifiers in play:
 *  - URL path segment: `tools/greek-room/repeated-words` (hyphenated — the
 *    fluent-ai HTTP route).
 *  - Envelope tool id:  `greek_room.repeated_words` (dotted snake_case — the
 *    library identifier returned in the response, validated in the route's
 *    response schema).
 */
export async function callRepeatedWords(
  req: RepeatedWordsRequest
): Promise<Result<ToolJobResponse<RepeatedWordsResult>>> {
  return callFluentAi('tools/greek-room/repeated-words', req, RepeatedWordsResultSchema);
}
