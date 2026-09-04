/**
 * Shared types for the fluent-ai (Python/FastAPI) integration.
 *
 * These mirror fluent-ai's generic tool-job envelope verbatim
 * (see fluent-ai/src/app/schemas/tool_job.py), so every AI-tool endpoint on
 * fluent-api consumes and forwards the same shape.
 *
 * ── snake_case convention (decision D8 / §8.1) ──────────────────────────────
 * Fields here use fluent-ai's snake_case verbatim (e.g. `job_id`, `created_at`,
 * `completed_at`). This is an INTENTIONAL, contained exception to fluent-api's
 * camelCase convention, scoped strictly to the AI-tools wire contract so the
 * pass-through to fluent-ai stays exact. Please keep these in snake_case;
 * renaming to camelCase would silently break the fluent-ai contract.
 * Approved in review:
 * https://github.com/eten-tech-foundation/fluent-api/pull/173#discussion_r3343677813
 * Rationale: docs/features/repeated-word-check/ai-tools-integration-suggestion.md §8.1
 */

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Structured error payload populated on the envelope when `status === "failed"`.
 * Mirrors fluent-ai's `ToolError` (src/app/schemas/tool_job.py): `{ code, message, details? }`.
 */
export interface ToolJobError {
  code: string; // e.g. 'TOOL_EXECUTION_ERROR'
  message: string;
  details?: unknown;
}

/**
 * Universal response envelope returned by every fluent-ai tool endpoint,
 * regardless of synchronous or (future) asynchronous execution.
 *
 * Mirrors fluent-ai's `ToolJobResponse[ResultT]` (src/app/schemas/tool_job.py).
 */
export interface ToolJobResponse<TResult> {
  job_id: string; // per-invocation UUID
  tool: string; // fluent-ai tool identifier, e.g. 'greek_room.repeated_words'
  status: JobStatus;
  result: TResult | null; // populated when status === 'completed'
  error: ToolJobError | null; // populated when status === 'failed'
  created_at: string; // ISO-8601 timestamp
  completed_at: string | null; // ISO-8601 timestamp for terminal states, else null
}
