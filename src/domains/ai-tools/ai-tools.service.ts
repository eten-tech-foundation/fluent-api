import type { ProjectWithLanguageNames } from '@/domains/projects/projects.types';
import type { ToolJobResponse } from '@/lib/services/fluent-ai/fluent-ai.types';
import type { Result } from '@/lib/types';

import { callFluentAi } from '@/lib/services/fluent-ai/fluent-ai.client';

import type {
  FluentAiRepeatedWordsRequest,
  RepeatedWordsRequest,
  RepeatedWordsResult,
} from './ai-tools.types';

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
 *
 * The upstream payload is built here rather than forwarded verbatim (D8,
 * amended by #420): `project` is the one resolved from the client's
 * `project_unit_id` and authorized by `requireAiToolsAccess`, so fluent-ai's
 * `project_id` / `project_name` always describe the project actually checked.
 */
export async function callRepeatedWords(
  req: RepeatedWordsRequest,
  project: Pick<ProjectWithLanguageNames, 'id' | 'name'>
): Promise<Result<ToolJobResponse<RepeatedWordsResult>>> {
  const fluentAiRequest: FluentAiRepeatedWordsRequest = {
    lang_code: req.lang_code,
    lang_name: req.lang_name,
    project_id: String(project.id),
    project_name: project.name,
    verses: req.verses,
  };
  return callFluentAi(
    'tools/greek-room/repeated-words',
    fluentAiRequest,
    RepeatedWordsResultSchema
  );
}
