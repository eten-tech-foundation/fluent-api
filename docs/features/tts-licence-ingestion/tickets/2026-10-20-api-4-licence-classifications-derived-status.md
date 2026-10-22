# Licence classifications + derived status (deny-by-default)

> **Status: FILED** — GitHub: [fluent-api#430](https://github.com/eten-tech-foundation/fluent-api/issues/430). Board: Fluent (#4) → `In Progress (Product)`.
> Suggested labels: `enhancement`, `ready-for-agent` · QA path: `DevQA` · Priority: P1

**Parent feature:** [`tts-licence-ingestion`](../plan.md) — Ticket API-4, Phase 2.
**Repo:** `fluent-api`.
**Working branch:** `feat/tts-licence-ingestion` (in `fluent-api`). Work on that branch directly, or branch from it (`git switch -c <your-branch> origin/feat/tts-licence-ingestion`) and target your PR at it, so the plan, design and ADR context travel with the ticket. The feature branch merges to `main` once the phase's tickets are done.
**Blocked by:** API-3 (the reviewed `licence-classifications.json` must be committed) and API-5 (derive status through `bibles.text_resource_id`, not the value join).
**Decision record:** [ADR 0003](../../../adr/0003-tts-licence-status-derived-from-licence-text.md).

## Problem

Phase 1's status is presumed, not decided, and a new Bible with an unfamiliar
licence would be marked `allowed`. From now on a Bible's status is derived
from its licence text's classification, and unclassified text is denied and
flagged for review.

## Behaviour

1. **Migration:** table `licence_classifications`
   - `normalized_text text PRIMARY KEY`
   - `status tts_license_status NOT NULL`
   - `rationale jsonb`, `classified_by text` (`'rule:arr'|'rule:cc-pd'|'ai'|'human'|'sync'`), `reviewed_at timestamptz`, `created_at`, `updated_at`
   - Load API-3's reviewed JSON in the same migration (or a seed run as a
     required deployment step, before the first Phase 2 sync).
2. **Sync derives status on every run** (retires API-1's insert-only rule).
   For each DBL text Bible's resource row:
   - empty/`null` notice → `forbidden`
   - `normalizeLicenceNotice(notice)` (the API-3 function) found → that status
   - not found → insert `{ normalized_text, status: 'unknown', classified_by: 'sync' }`
     (`ON CONFLICT DO NOTHING`) and set the Bible `unknown`. This is the
     review flag.
     Only write `tts_license_status` when it differs, so trigger 0037 bumps
     watermarks only on real changes.
3. API-2's sweep becomes redundant (rule 1 is in the data). Remove it from
   `sync-dbl-catalogue.ts`.
4. Log `{ allowed, forbidden, unknown, newlyFlagged }` at the end of the sync.
   `newlyFlagged > 0` should be a `warn` so a new licence is noticed.
5. Reclassifying = update the `licence_classifications` row; the next sync
   propagates it to every Bible sharing that text. No per-Bible override.

## Acceptance criteria

- [ ] After deploy + sync, every DBL Bible's status equals its notice's classification; null notice → `forbidden`.
- [ ] A Bible with a never-seen notice becomes `unknown` and its normalized text appears in `licence_classifications` as `unknown`/`sync`.
- [ ] Changing a classification row and re-syncing updates all Bibles sharing that text and bumps their `updated_at`; a no-op re-sync bumps nothing.
- [ ] A manual `UPDATE` on one `bible_provider_resources` row is overwritten by the next sync (documented, per ADR 0003).
- [ ] Backlog query documented in the runbook/README: `SELECT * FROM licence_classifications WHERE status = 'unknown'`.

## Tests

- Unit: derivation function (null → forbidden, hit → status, miss → unknown + flag).
- Integration: migration loads data; derived sync idempotent; reclassification propagates; watermark only on change.

## Deployment

The data load must happen before the first Phase 2 sync. At `Passed QA`:
`npm run db:migrate`, then `npm run db:sync:dbl` on QA, then prod. Check the
logged `unknown` count against API-3's file (expected: 0 for existing notices).
