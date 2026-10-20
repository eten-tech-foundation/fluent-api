# AI licence classification pass

> **Status: FILED** — GitHub: [fluent-api#429](https://github.com/eten-tech-foundation/fluent-api/issues/429). Board: Fluent (#4) → `In Progress (Product)`.
> Suggested labels: `enhancement`, `ready-for-human` · QA path: `DevQA` · Priority: P1

**Parent feature:** [`tts-licence-ingestion`](../plan.md) — Ticket API-3, Phase 2.
**Repo:** `fluent-api`.
**Working branch:** `feat/tts-licence-ingestion` (in `fluent-api`). Work on that branch directly, or branch from it (`git switch -c <your-branch> origin/feat/tts-licence-ingestion`) and target your PR at it, so the plan, design and ADR context travel with the ticket. The feature branch merges to `main` once the phase's tickets are done.
**Blocked by:** Phase 1 (API-1, API-2) run on prod — this classifies prod's real notices.
**Blocks:** API-4.

`ready-for-human`: needs model API keys, a judgment call on the prompt, and a
human sign-off on the output.

## Problem

Phase 1 presumed every DBL Bible `allowed`. We need a defensible decision per
distinct licence notice — the "poor man's due diligence" Joel described — that
Phase 2 can enforce deny-by-default against.

## Behaviour

An **offline developer script** (`src/db/scripts/classify-licence-notices.ts`,
`npm run licences:classify`); never runs in the sync or at request time.

1. Read distinct non-null `license_notice` values for `provider='dbl'` (from a
   prod read replica or an exported list).
2. Normalize each with a shared `normalizeLicenceNotice()` (lowercase, collapse
   whitespace, strip `©`/`(c)`/`copyright` tokens and 4-digit years). API-4's
   sync must use the **same function**, so put it in
   `src/domains/bible-provider-resources/`. Group by the normalized text.
3. Apply the rules **in order**:
   1. All rights reserved in any language (EN/FR/ES/PT/DE… phrases) → `forbidden`.
   2. Any Creative Commons licence (incl. NC/ND) or public domain → `allowed`.
   3. Otherwise ask 2–3 models (e.g. Claude plus two others) the same prompt.
      The prompt describes our usage: in-app, on-demand synthesis of a passage
      at a time; cached server-side; never downloadable; never the whole Bible
      in one go. Each model returns `allowed | forbidden` + one-sentence
      rationale.
      - Any model says explicit prohibition → `forbidden`.
      - Models disagree → `unknown` (human decides).
      - Otherwise → `allowed`.
4. Write `docs/features/tts-licence-ingestion/reference/licence-classifications.json`:
   `[{ normalizedText, exampleNotice, status, rule: 'arr'|'cc-pd'|'ai', rationale: {model: text}, bibleCount }]`.
5. **Human review:** a reviewer resolves every `unknown`, spot-checks `ai`
   rows, and records `reviewedBy`/`reviewedAt` in the file. Commit the reviewed file.

## Acceptance criteria

- [ ] Every distinct prod notice appears exactly once (by normalized text) in the committed JSON.
- [ ] No row is left `unknown` without a reviewer note.
- [ ] Rule 1 catches all English "all rights reserved" notices that API-2 flipped (consistency check).
- [ ] The prompt and the model IDs used are recorded in the file header for audit.

## Tests

Unit tests for `normalizeLicenceNotice()` and for the rule-ordering/vote logic (mock model responses). No tests against live models.
