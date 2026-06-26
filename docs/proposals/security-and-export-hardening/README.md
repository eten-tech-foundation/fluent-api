# Security & Export Hardening — Proposal

**Status:** Draft for review (2026-06-18). Ticket 1 (auth on open domains) is
**partially implemented** on branch `fix/require-auth-bibles-usfm`; tickets 2–4
are scoped but not started.
**Origin:** Code audit of `fluent-web` + `fluent-api` (2026-06-18) plus reviewer
feedback. This folder captures the four follow-ups the audit surfaced and the
decision made on each.

## Background

A review of the API found several routes that ship without authentication, an
async export pipeline whose failures are silently swallowed, and a couple of
UX/QA gaps around export errors and concurrent editing. The reviewer triaged
each finding; the decisions are encoded in the per-ticket docs below.

## Tickets

| #   | Title                                                                    | Priority        | Status                                                         |
| --- | ------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------- |
| 1   | [Require auth on open domains](01-auth-open-domains.md)                  | P0 (security)   | Bibles + USFM done on branch; bible-texts/books + scoping open |
| 2   | [Export error UX + Azure logging](02-export-error-ux-and-logging.md)     | P1              | Not started                                                    |
| 3   | [Async export pipeline hardening](03-async-export-pipeline-hardening.md) | P2 (pre-enable) | Not started                                                    |
| 4   | [Verify concurrent-editor warning](04-concurrent-editor-warning-qa.md)   | P2 (QA)         | Not started                                                    |

## Key framing corrections from the audit

- **The export users actually use works.** `fluent-web` calls the _synchronous_
  streaming endpoint (`POST /project-units/{id}/usfm`), which runs in-process in
  the API. The job-swallowing and cross-process-disk bugs live in the _async_
  pipeline (`/usfm/async` → worker → `/downloads`), which is **not wired to the
  UI**. Ticket 3 is therefore "fix before enabling," not a live outage.
- **Concurrent editing is intentional.** There is no real-time collaborative
  editor by design; last-write-wins on verses is expected. The only guard is the
  2nd-editor presence warning, which already exists — ticket 4 is QA, not build.

## Auth pattern reference

The established pattern these tickets follow lives in
`src/middlewares/role-auth.ts`, `src/domains/projects/projects.route.ts`, and
`src/domains/translated-verses/translated-verse-auth.middleware.ts`
(`authenticateUser` → `requirePermission` → record-level policy with org
isolation).
