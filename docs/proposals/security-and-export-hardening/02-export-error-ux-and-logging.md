# Ticket 2 — Export error UX + Azure logging

**Priority:** P1
**Status:** Not started.

## Problem

Two gaps on the _synchronous_ export path the editor actually uses
(`fluent-web` `useExportUsfm` → `POST /project-units/{id}/usfm`):

1. **`fluent-web` omits credentials.** `features/projects/hooks/useExportUsfm.ts`
   is the only API call in the app that does not pass `credentials: 'include'`.
   It only works today because the endpoint is unauthenticated. **Once ticket 1's
   auth lands, this request will 401 and the editor export breaks.** The two
   changes must ship together (or the web fix first).
2. **Failures are invisible.** On failure the hook throws a generic
   `Error('Failed to export USFM')`, the UI surfaces nothing actionable, and the
   API does not consistently log the failure to App Insights.

## Scope

- **fluent-web:** add `credentials: 'include'` to `useExportUsfm.ts`; surface a
  real, retryable error state in `ExportProjectDialog` (toast / inline message).
- **fluent-api:** ensure sync-export handler failures are logged through the
  standard logger → App Insights, with project-unit context, and that no raw
  internal error string is returned to the client (the USFM handlers currently
  return `{ error, details }` with `error.message` — align with the rest of the
  API's `{ message }` envelope).

> **Consumer compatibility (breaking change).** Aligning the USFM error envelope
> (`{ error, details }` → `{ message }`) breaks any client reading the old
> shape. `fluent-web`'s export error handling must be updated in lockstep, and
> any USFM route tests asserting the old `{ error, details }` shape updated, so
> the envelope change lands together with the `fluent-web` update.

## Acceptance criteria

- Triggering an export failure shows the user a clear, retryable error.
- The failure appears in Azure App Insights with enough context to triage.
- After ticket 1, the editor export still succeeds for authorized users.

## Release coupling

Ship the `fluent-web` credentials fix **no later than** the ticket-1 API auth
change. Recommended order: deploy web credentials fix → deploy API auth.
