# All-rights-reserved sweep

> **Status: FILED** — GitHub: [fluent-api#428](https://github.com/eten-tech-foundation/fluent-api/issues/428). Board: Fluent (#4) → `In Progress (Product)`.
> Suggested labels: `enhancement`, `ready-for-agent` · QA path: `DevQA` · Priority: P0

**Parent feature:** [`tts-licence-ingestion`](../plan.md) — Ticket API-2, Phase 1.
**Repo:** `fluent-api`.
**Working branch:** `feat/tts-licence-ingestion` (in `fluent-api`). Work on that branch directly, or branch from it (`git switch -c <your-branch> origin/feat/tts-licence-ingestion`) and target your PR at it, so the plan, design and ADR context travel with the ticket. The feature branch merges to `main` once the phase's tickets are done.
**Blocked by:** API-1. Ships in the same release.

## Problem

API-1 marks every DBL Bible `allowed`. All rights reserved is the one hard
rule: such a Bible must never be `allowed`, even in the interim.

## Behaviour

Add a function (e.g. `applyAllRightsReservedSweep()` in
`src/domains/bible-provider-resources/`) that runs one statement:

```sql
UPDATE bible_provider_resources
SET tts_license_status = 'forbidden'
WHERE provider = 'dbl'
  AND license_notice ILIKE '%all rights reserved%'
  AND tts_license_status <> 'forbidden';
```

- Call it as the **final step** of `sync-dbl-catalogue.ts` (Step 5/5), so it
  always follows the sync.
- Match English only. Log `{ forbidden: <rows updated>, unmatchedDistinctNotices:
<count> }`, plus the list of distinct non-null notices that did _not_ match
  (at debug level if long), so non-English all-rights-reserved texts are visible
  for Phase 2.
- The `<> 'forbidden'` guard keeps re-runs from firing trigger 0037.

## Acceptance criteria

- [ ] A DBL resource whose notice contains "All Rights Reserved" (any case) is `forbidden` after `npm run db:sync:dbl`.
- [ ] Re-running changes nothing and bumps no `bibles.updated_at`.
- [ ] Non-DBL rows and rows with a `null` notice are untouched.
- [ ] fluent-web shows the licence-fence reason (not synthesis) for that Bible on QA.

## Tests

Integration test: seed `allowed` rows with matching / non-matching / null notices and a non-DBL row; assert only the matching DBL row flips; second call updates 0.
