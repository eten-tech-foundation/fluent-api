import { z } from '@hono/zod-openapi';

/**
 * Per-tool Zod schemas for the AI-tools domain.
 *
 * ── Intentional snake_case (decision D8 / §8.1) ─────────────────────────────
 * The field names below mirror fluent-ai's wire contract VERBATIM
 * (`lang_code`, `snt_id`, `start_position`, etc.). This is an INTENTIONAL,
 * contained exception to fluent-api's camelCase convention, scoped strictly to
 * the AI-tools domain so the wire contract stays aligned with fluent-ai.
 * Please keep these in snake_case; renaming to camelCase would silently break
 * the fluent-ai contract.
 * Approved in review:
 * https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343677813
 * Rationale: docs/features/repeated-word-check/ai-tools-integration-suggestion.md §8.1
 *
 * The result/response schemas mirror the live fluent-ai contract:
 *   fluent-ai/src/app/schemas/greek_room.py
 *   fluent-ai/src/app/schemas/tool_job.py
 */

// ─── Forward direction: fluent-web → fluent-api → fluent-ai (§8.1) ────────────
//
// D8 originally forwarded the client body to fluent-ai verbatim. Amended by
// #420: the two hops now have distinct shapes, and every field means what its
// name says. The client identifies the milestone it is checking
// (`project_unit_id`); fluent-api resolves that to the owning project,
// authorizes against it, and fills fluent-ai's `project_id` / `project_name`
// from the resolved row. `lang_code`, `lang_name` and `verses` still pass
// through as sent. See ai-tools-integration-suggestion.md §8.1 (D8 amendment).

export const VerseInputSchema = z.object({
  snt_id: z.string().min(1),
  text: z.string(),
});

export type VerseInput = z.infer<typeof VerseInputSchema>;

/** fluent-web → fluent-api request body. */
export const RepeatedWordsRequestSchema = z.object({
  lang_code: z.string().min(1),
  lang_name: z.string().min(1),
  // A `project_units.id` (the milestone being checked) — NOT a `projects.id`.
  // fluent-api resolves the owning project server-side; the client never
  // supplies `project_id` / `project_name` (#420).
  project_unit_id: z.number().int().positive(),
  // Required and non-empty so we fail fast at the route layer rather than incur
  // a round-trip to fluent-ai for a trivially-invalid request.
  verses: z.array(VerseInputSchema).min(1),
});

export type RepeatedWordsRequest = z.infer<typeof RepeatedWordsRequestSchema>;

/**
 * fluent-api → fluent-ai request body, built server-side by
 * `callRepeatedWords`. Mirrors fluent-ai's `RepeatedWordsRequest`
 * (fluent-ai/src/app/schemas/greek_room.py).
 */
export interface FluentAiRepeatedWordsRequest {
  lang_code: string;
  lang_name: string;
  // The resolved `projects.id`. fluent-ai declares `project_id: str` (Pydantic
  // v2, strict — it does not coerce an int), so it is sent as a string.
  project_id: string;
  // The resolved project's name, from fluent-api's own `projects` row.
  project_name: string;
  verses: VerseInput[];
}

// ─── Reverse direction: fluent-ai → fluent-api → fluent-web (§8.2) ────────────

export const RepeatedWordsFindingSchema = z.object({
  snt_id: z.string(),
  repeated_word: z.string(),
  surf: z.string(),
  start_position: z.number().int().nonnegative(),
  legitimate: z.boolean(),
  // Upstream Greek-Room numeric severity (e.g. 0.1 legitimate, 0.5 suspicious).
  severity: z.number(),
});

export const RepeatedWordsSummarySchema = z.object({
  total_findings: z.number().int().nonnegative(),
  legitimate_count: z.number().int().nonnegative(),
  verse_count: z.number().int().nonnegative(),
});

export const RepeatedWordsResultSchema = z.object({
  // Upstream library identity fields (distinct from the envelope's `tool`).
  lang_code: z.string(),
  provider: z.string(),
  check: z.string(),
  findings: z.array(RepeatedWordsFindingSchema),
  summary: RepeatedWordsSummarySchema,
});

export type RepeatedWordsResult = z.infer<typeof RepeatedWordsResultSchema>;

export const RepeatedWordsResponseSchema = z.object({
  job_id: z.string().uuid(),
  // The envelope's tool identifier — distinct from the result's library fields.
  tool: z.literal('greek_room.repeated_words'),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  result: RepeatedWordsResultSchema.nullable(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    })
    .nullable(),
  created_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
});

export type RepeatedWordsResponse = z.infer<typeof RepeatedWordsResponseSchema>;
