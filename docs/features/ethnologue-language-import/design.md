# Ethnologue Language Import — Design Spec

**Date:** 2026-08-05
**Status:** Approved for implementation planning
**Source:** Issue #225 (Import Ethnologue Language Data as System-Wide Language List); supersedes the approach in PR #257

## Problem

Issue #225 asks for an idempotent, re-runnable import of Ethnologue's
language list (ISO 639-3 code + English name) into the `languages` table,
with RTL script direction inferred from a fixed name/code list, no
duplicate rows, and old rows preserved across re-runs.

PR #257 implemented this as a rewrite of `src/db/seeds/languages.ts` — the
same script `db:setup` runs on every local/dev database bring-up. Review of
that PR surfaced blocking problems:

- The rewritten seeder requires a `data/language-data/` folder that isn't
  committed anywhere in the repo, isn't documented, and has no fetch step —
  running `db:seed:languages` fails immediately with "folder not found."
  Every local seed now depends on data that doesn't exist in source control.
- `languages.lang_code_iso_639_3` has no unique constraint, so "no duplicate
  rows" is an in-memory best-effort check, not a guarantee.
- `lang_name` / `lang_name_localized` are `varchar(100)`; the script silently
  truncates any longer value to fit, which can corrupt data with no trace.
- No tests, despite the issue's own estimate budgeting for unit testing.

This spec replaces that approach.

## Goals

- Importing Ethnologue data must not interfere with, or depend on files
  required by, the existing local dev seed chain (`db:setup` /
  `db:seed:languages`).
- `languages.lang_code_iso_639_3` duplicates are prevented at the database
  level, not just in application code.
- `lang_name` / `lang_name_localized` never get silently truncated.
- Import is idempotent: re-running with the same file inserts nothing new;
  re-running with an updated file inserts only genuinely new codes. Existing
  rows are never updated or deleted.
- Core import logic is reusable from something other than a CLI invocation
  later (an admin upload endpoint or a queued job), without rewriting it.

## Non-Goals

- Building the admin-upload UI or job-queue worker themselves — only
  structuring the code so those can call the same logic later.
- Resolving where localized names ultimately come from long-term — the
  issue leaves this an open question; this spec includes an enrichment path
  but treats it as separable from the core import.
- Updating existing rows when upstream data changes (e.g. Ethnologue renames
  a language on a later re-run). Out of scope per explicit decision below.

## Schema Changes

Via a new Drizzle migration (`drizzle-kit generate`):

- `languages.lang_code_iso_639_3`: add a plain `UNIQUE` constraint. Postgres
  allows unlimited `NULL`s under a plain unique constraint, which is what's
  wanted here — many existing rows have no ISO mapping. Matches how other
  unique columns are already declared in this schema (e.g. `bibles.name`).
- `languages.lang_name`: `varchar(100)` → `varchar(255)`.
- `languages.lang_name_localized`: `varchar(100)` → `varchar(255)`.
  `255` matches the convention already used for name columns elsewhere in
  this schema (`bibles.name`, `organizations.name`).

`src/db/seeds/languages.ts` and `src/db/seeds/data/languages.json` are
**not modified**. The existing small dev-fixture seeder keeps working
exactly as-is and stays wired into `db:setup`.

## Module Layout

New domain-local import logic, separate from the request-serving
`languages.service` / `languages.repository` (which stay focused on the
read API):

```
src/domains/languages/import/
  csv.ts                    — parseLine/detectDelimiter/readCsvFromString (pure)
  rtl.ts                    — isRTL() + RTL keyword/code lists (pure, carried over from #257)
  import-ethnologue.ts      — importEthnologueLanguages(csvContent: string): Promise<ImportSummary>
  enrich-localized-names.ts — enrichLocalizedNames(csvContent: string): Promise<EnrichSummary>
```

Both entry functions take **file content as a string**, not a file path.
This is deliberate: the same function can later be called from an
admin-upload HTTP handler (buffer from a multipart request) or a queue job
(buffer fetched from storage) without modification. Filesystem/path
concerns are confined to the CLI wrappers described below.

## CLI Wrappers

```
src/db/scripts/import-ethnologue-languages.ts   → npm run db:import:languages -- <path>
src/db/scripts/enrich-language-names.ts         → npm run db:import:language-names -- <path>
```

Each follows the existing `src/db/scripts/create-user.ts` shape: parse
`argv`, `readFileSync` the given path, call the corresponding domain
function, `console.log` the returned summary, `process.exit(0)` on success
or `process.exit(1)` on failure. Source CSV/TSV files are **not** committed
to the repo — each operator supplies their own file path at invocation
time, avoiding any redistribution/licensing question around Ethnologue's
data and keeping the repo free of a large third-party dataset.

## Data Flow — Import

1. CLI reads the file at the given path, passes its content to
   `importEthnologueLanguages()`.
2. Parses the `LangID` / `Name` columns (delimiter auto-detected between
   comma and tab; the quoted-field parser carried over from #257 is reused
   as-is — it already handles this data shape correctly).
3. Dedupes in-memory by code (first row wins), validates a 3-character code
   and non-empty name, computes `scriptDirection` via `isRTL()`.
4. **Rejects** (throws), rather than truncates, any name over 255
   characters — the error names the offending code so a bad row surfaces
   immediately instead of silently corrupting a stored name.
5. Selects existing codes from the DB, filters them out in-memory
   (insert-only), then inserts new rows in chunks of 1000 inside a single
   transaction, using `.onConflictDoNothing()` targeting the new unique
   constraint. This is a defense-in-depth backstop against a race between
   the `SELECT` and the `INSERT` — not a replacement for the in-memory
   check, which remains the primary mechanism.
6. Returns
   `{ totalRows, inserted, skippedExisting, skippedInvalid, rtlCount, ltrCount }`.

Re-running with the same file: `inserted` is 0. Re-running with a newer
file: only genuinely new codes are inserted. Existing rows are never
updated or deleted.

## Data Flow — Enrichment

1. CLI reads the SIL autonyms file, passes its content to
   `enrichLocalizedNames()`.
2. Parses the `ISO_639` / `Print_Name` columns.
3. For each code that exists in the DB **and** currently has
   `lang_name_localized IS NULL`, sets it — rejecting (not truncating) any
   value over 255 characters.
4. Never overwrites an already-set localized name; never creates new
   language rows.
5. Returns `{ totalRows, enriched, skippedNoMatch, skippedAlreadySet }`.

## Error Handling

- Missing/unreadable file path: caught in the CLI wrapper with a clear
  stderr message and exit code 1; the domain module never runs.
- Missing required column (`LangID`/`Name` or `ISO_639`/`Print_Name`): the
  domain module throws a descriptive error before touching the database.
- Oversized name: throws (see above) instead of silently truncating.
- Invalid rows (bad code length, empty name): skipped and counted in the
  returned summary, not silently dropped without a trace.
- Database errors during the transaction propagate; nothing partially
  commits, matching #257's chunked-transaction approach.

## Testing

Following this repo's existing pattern (e.g.
`src/domains/ai-suggestions/ai-suggestions.repository.test.ts` mocks `db`
entirely for repository-layer tests):

- `csv.ts`, `rtl.ts`: pure unit tests, no mocking required — delimiter
  detection, quoted-field parsing, RTL keyword match, RTL explicit-code
  match.
- `import-ethnologue.ts`, `enrich-localized-names.ts`: unit tests with `db`
  mocked via the same chainable-mock pattern used elsewhere in this repo —
  covering insert-only re-run idempotency, first-row-wins dedup,
  oversized-name rejection, invalid-row skipping, and enrichment never
  overwriting an existing localized name.

## Key Decisions

| Decision                  | Choice                                                                                           | Why                                                                                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where import logic lives  | Not the seed chain; new `src/domains/languages/import/` modules + `src/db/scripts/` CLI wrappers | Seeder must keep working without this data; precedent for standalone scripts already exists (`create-user.ts` et al.)                                                               |
| Source file delivery      | CLI path argument, not committed to repo                                                         | Avoids licensing/redistribution concerns and repo bloat; matches how `create-user.ts`-style scripts already take arguments                                                          |
| Localized-name enrichment | Included, but as a fully separate function/script from core import                               | Issue leaves localized-name sourcing an open question; keeping it separable avoids baking in an assumption and matches the likely future where each becomes its own upload/job step |
| Core logic shape          | Reusable functions taking file content, called by thin CLI wrappers                              | Anticipates admin-upload or job-queue delivery later without a rewrite                                                                                                              |
| CSV parsing               | Hand-rolled parser carried over from #257                                                        | Already handles this data's quoting/delimiter shape; avoids adding a new dependency for a script that runs a handful of times a year                                                |
| Unique constraint         | Plain `UNIQUE` on `lang_code_iso_639_3` (NULLs unrestricted)                                     | Matches existing schema convention; many rows legitimately have no ISO code                                                                                                         |
| Column width              | `varchar(255)` for `lang_name` / `lang_name_localized`                                           | Matches convention used by other name columns in this schema                                                                                                                        |
| Re-run semantics          | Insert-only; never update or delete existing rows                                                | Matches the issue's literal spec; avoids clobbering data other tables may reference by name                                                                                         |
