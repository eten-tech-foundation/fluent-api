import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolJobResponse } from '@/lib/services/fluent-ai/fluent-ai.types';

import { callFluentAi } from '@/lib/services/fluent-ai/fluent-ai.client';
import { ErrorCode } from '@/lib/types';

import type { RepeatedWordsResult } from './ai-tools.types';

import { callRepeatedWords } from './ai-tools.service';
import { RepeatedWordsResultSchema } from './ai-tools.types';

/**
 * Service-level tests for the upstream payload fluent-api builds for fluent-ai.
 *
 * The route test mocks this service, so it cannot see what actually goes on the
 * wire. These pin the #420 contract: fluent-ai's `project_id` / `project_name`
 * come from the RESOLVED project, never from the client's `project_unit_id`.
 */

vi.mock('@/lib/services/fluent-ai/fluent-ai.client', () => ({
  callFluentAi: vi.fn(),
}));

// Non-identity mapping (unit 8 → project 4), so a unit id leaking through as
// the project id cannot pass by coincidence.
const REQUEST = {
  lang_code: 'eng',
  lang_name: 'English',
  project_unit_id: 8,
  verses: [{ snt_id: 'GEN 1:1', text: 'In in the beginning' }],
};

const PROJECT = { id: 4, name: 'Resolved Project' };

const ENVELOPE: ToolJobResponse<RepeatedWordsResult> = {
  job_id: '11111111-1111-1111-1111-111111111111',
  tool: 'greek_room.repeated_words',
  status: 'completed',
  result: null,
  error: null,
  created_at: '2026-10-19T00:00:00.000Z',
  completed_at: '2026-10-19T00:00:01.000Z',
};

describe('callRepeatedWords', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(callFluentAi).mockResolvedValue({ ok: true, data: ENVELOPE });
  });

  it('sends fluent-ai the resolved project id (as a string) and name, plus the client fields', async () => {
    await callRepeatedWords(REQUEST, PROJECT);

    expect(callFluentAi).toHaveBeenCalledOnce();
    expect(callFluentAi).toHaveBeenCalledWith(
      'tools/greek-room/repeated-words',
      {
        lang_code: 'eng',
        lang_name: 'English',
        project_id: '4',
        project_name: 'Resolved Project',
        verses: [{ snt_id: 'GEN 1:1', text: 'In in the beginning' }],
      },
      RepeatedWordsResultSchema
    );
  });

  it('returns the client result unchanged, including upstream failures', async () => {
    const failure = {
      ok: false as const,
      error: { code: ErrorCode.AI_SERVICE_UNAVAILABLE, message: 'fluent-ai unreachable' },
    };
    vi.mocked(callFluentAi).mockResolvedValue(failure);

    await expect(callRepeatedWords(REQUEST, PROJECT)).resolves.toEqual(failure);
  });
});
