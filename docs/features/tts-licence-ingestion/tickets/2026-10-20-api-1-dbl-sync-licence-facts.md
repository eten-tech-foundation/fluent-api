# DBL sync writes text-Bible licence facts

> **Status: DRAFT** — not yet filed. Board: Fluent (#4) → `In Progress (Product)`.
> Suggested labels: `enhancement`, `ready-for-agent` · QA path: `DevQA` · Priority: P0

**Parent feature:** [`tts-licence-ingestion`](../plan.md) — Ticket API-1, Phase 1.
**Repo:** `fluent-api`.
**Working branch:** `feat/tts-licence-ingestion` (in `fluent-api`). Work on that branch directly, or branch from it (`git switch -c <your-branch> origin/feat/tts-licence-ingestion`) and target your PR at it, so the plan, design and ADR context travel with the ticket. The feature branch merges to `main` once the phase's tickets are done.
**Blocks:** API-2. Makes fluent-web's licence fence open for DBL Bibles.

## Problem

The licence fence in fluent-web only synthesizes TTS for Bibles whose TTS
licence status is `allowed`. `npm run db:sync:dbl` never writes
`bible_provider_resources`, so every DBL Bible reads as `unknown` and TTS is
off. Every Bible our DBL key can see is open licensed, so for the E10 Summit
we mark them all `allowed` and record each one's licence notice for Phase 2
classification.

## Behaviour

1. `syncBiblesFromDbl` calls `client.getBibles({ includeFullDetails: true })`
   and receives `copyright`. `getBibles` currently parses with
   `dblBibleSummarySchema`, which strips `copyright`/`info`; parse with a
   schema that keeps them when `includeFullDetails` is set (e.g.
   `dblBibleSchema`).
2. For every Bible the sync upserts into `bibles` (same skip rules: no
   matching language → no `bibles` row → no resource row), upsert one
   `bible_provider_resources` row:
   - `provider = 'dbl'`, `external_id = bible.id`
   - `license_notice = copyright` trimmed, empty → `null`
   - `display_name` = the Bible's stored name
   - `tts_license_status = 'allowed'` **on insert only**
3. On conflict `(provider, external_id)`: update `license_notice` and
   `display_name`; **never touch `tts_license_status`**. Existing seeded or
   manually set rows (BSB `allowed`, the IRV demo row, anything set to
   `forbidden`) keep their status.
4. Write the resource rows in the same transaction as the `bibles` upsert, or
   immediately after it in the same step, so a failed run leaves no half state.
5. Extend the sync summary with `licenceFacts: { inserted, updated,
distinctNotices, nullNotices }` and log it in `sync-dbl-catalogue.ts`.
6. Audio recordings (`audioBibles`) and `bibles.audio_resource_id` are
   untouched.

Re-running the script must be idempotent: no duplicate rows, no status
changes, and no watermark bump when nothing changed (trigger 0037 fires only on
real changes, so update only when values are `IS DISTINCT FROM` the current
ones).

## Acceptance criteria

- [ ] After `npm run db:sync:dbl` on a fresh DB, every DBL-synced `bibles` row has exactly one `bible_provider_resources` row with `tts_license_status='allowed'`.
- [ ] A second run inserts 0 rows and changes no statuses.
- [ ] A row set to `forbidden` before the run is still `forbidden` after it.
- [ ] A changed `copyright` upstream updates `license_notice` and advances that Bible's `updated_at` (via trigger 0037).
- [ ] `GET /bibles` returns `ttsLicenseStatus: 'allowed'` for synced DBL Bibles.
- [ ] Logged summary includes the distinct-notice and null-notice counts.

## Tests

- `dbl-bible-sync.test.ts`: `includeFullDetails` is requested; resource rows built per synced Bible; empty copyright → `null` notice; skipped-language Bibles get no resource row.
- Repository/integration test (pattern: `catalogue-sync.watermark.integration.test.ts`): insert-only status, conflict updates notice only, no-op re-run doesn't bump `bibles.updated_at`.
- `dbl.client.test.ts`: full-details list parse keeps `copyright`.

## Deployment

At `Passed QA`: after release, run `npm run db:sync:dbl` on QA, then prod.
Ships with API-2.
