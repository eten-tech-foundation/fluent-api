# Ticket 1 — Require auth on open API domains

**Priority:** P0 (security)
**Status:** Bibles + USFM implemented on `fix/require-auth-bibles-usfm`
(2026-06-18). Remaining items below are open.

## Problem

Several route groups declared no `middleware`, so the global pass-through
`authenticate` middleware left them effectively public:

- `src/domains/usfm/usfm.route.ts` — all 5 export/download/job routes.
- `src/domains/bibles/bibles.route.ts` — full CRUD incl. create/update/delete.
- `src/domains/bibles/bible-texts/bible-texts.route.ts` — reads incl. the bulk
  endpoint (documented "No authentication required").
- `src/domains/books/books.route.ts`, `src/domains/bible-books/bible-books.route.ts`.

The OpenAPI specs already document `401` responses, so spec and behaviour had
drifted. The established pattern (projects / users / chapter-assignments) layers
`authenticateUser` → `requirePermission` → record-level policy with org
isolation; these domains simply skipped it.

## Decisions (reviewer, 2026-06-18)

- **USFM:** a general auth check is sufficient for now; deeper authorization
  needs clarification on what it exports (see follow-up 1 — it exports
  per-project content, so project-scoping is recommended).
- **Bibles:** anyone logged in may read; modification is an admin ability, so
  **flat-deny writes** until the user-management work introduces an admin role.

## Implemented on this branch

- Added `denyUntilAdminRole()` to `src/middlewares/role-auth.ts` — a placeholder
  hard-deny (403) for admin-only actions, to be swapped for
  `requirePermission(<admin permission>)` when the admin role lands.
- **Bibles** (`bibles.route.ts`): reads (`GET /bibles`, `/bibles/{id}`,
  `/bibles/language/{languageId}`) → `[authenticateUser]`; writes (`POST`,
  `PATCH`, `DELETE`) → `[authenticateUser, denyUntilAdminRole()]`.
- **USFM** (`usfm.route.ts`): all 5 routes → `[authenticateUser]`.

Verified: `typecheck`, `lint`, and the 78-test suite all pass.

## Open / recommended follow-ups

1. **USFM project-scoping (recommended).** The export pulls _per-project_
   translated verse content (`usfm.service.ts` `getProjectBooks` +
   `getBookVerses`), so a logged-in user from another org can still export a
   project they do not belong to. Recommend a `requireProjectUnitAccess`
   middleware that resolves `projectUnitId` → project → org and applies
   `ProjectPolicy.read`, mirroring `translated-verse-auth.middleware.ts`. Apply
   to the three `/project-units/{projectUnitId}/usfm*` routes. (`/jobs` and
   `/downloads` are async-only — bind them to an owner in ticket 3.)
2. **bible-texts / books / bible-books reads — DECIDED (reviewer, 2026-06-26):
   anonymous access is intentional.** The ~1200-chapter bulk return exists for a
   mobile sync feature, so these reads stay unauthenticated. Per the agreed
   fallback, the bulk `POST /bibles/{bibleId}/bulk-texts` endpoint is documented
   as intentionally anonymous and **rate-limited per client** (in-memory,
   per-process fixed-window guard in `src/middlewares/rate-limit.ts`) as a scraping/abuse
   guard — implemented alongside this decision (#199).

## Release coupling

Securing `POST /project-units/{id}/usfm` will break the editor's export unless
`fluent-web` sends credentials — see **ticket 2**, which must ship together with
(or ahead of) this change.

## Acceptance criteria

- Unauthenticated requests to the secured routes return 401.
- Authenticated non-admin requests to bibles writes return 403.
- The editor's sync export still succeeds for authorized users once `fluent-web`
  sends credentials.
