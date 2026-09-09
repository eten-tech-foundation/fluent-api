# Pericope AI suggestions

Supports [fluent-web#394](https://github.com/eten-tech-foundation/fluent-web/issues/394). Depends on the `markers.headings` storage contract in [fluent-api#320](https://github.com/eten-tech-foundation/fluent-api/pull/320).

The editor queues the active and next pericope by their source identifiers. The API resolves each identifier against the project's selected pericope set, source Bible, book, and chapter assignment. It queues individual source verses whose translation is absent or blank and whose suggestion is not already cached. Verse 1 and saved empty rows participate. Nonempty translations remain untouched.

Groups with a nonempty source title may also queue a heading-only job. A heading is omitted when the first target verse already has authored `markers.headings`, or when a title suggestion is cached. Title jobs use distinct singleton keys including the selected set and exact source range. Existing scripture job keys and payloads remain compatible.

## Public HTTP contract

Use the exact `pericopeNumber` returned by the chapter pericopes endpoint. Sets with sections use a compound identity such as `1_4a`; this keeps two sections that reuse the same raw pericope number separate.

- `POST /ai-suggestions/queue-pericopes`: `{projectUnitId,bibleId,bookCode,chapterNumber,pericopeNumbers:string[]}` → `{queued,thresholdMet}`. Accepts 1–2 unique identifiers, each 1–100 characters without commas. Chapter assignment AI enablement and the existing activation threshold control queuing. Invalid batches queue nothing. Queue submission failures return an error; singleton deduplication is successful submission.
- `GET /ai-suggestions/pericopes`: the same fields in the query; `pericopeNumbers=4a,4b` is a comma-separated string. Returns `{data:[{pericopeNumber,bibleTextId,suggestedText,modelInfo?}]}`. `bibleTextId` identifies the first source-backed verse in the chapter group. Groups without source titles or with authored headings return no title.
- `POST /ai-suggestions/pericopes/usage`: `{projectUnitId,bibleTextId,pericopeNumber,wasUsed}`. A matching persisted suggestion from the current set must exist. Exposure (`false`) and acceptance (`true`) are recorded separately from verse suggestion usage. Once accepted, a delayed exposure cannot change the record back to false.

All public endpoints reuse authenticated project access and `project:view` checks. Source verse IDs and title text are resolved on the server, never supplied by the browser.

## Worker HTTP contract

Existing trigger/context fields remain required. Optional `pericopeNumber` selects a heading-only job, and API-generated jobs also include `pericopeSetId`. Heading context validates the exact server-derived range and current set. The response adds `sectionHeading:{pericopeNumber,pericopeSetId,bibleTextId,sourceTitle}` or `null` when title generation no longer applies. `sourceVerses` is ordered and limited to exact pericope membership, including for sparse ranges. The worker treats `sectionHeading:null` as a successful no-op.

`POST /ai-suggestions/internal/results` continues accepting `{items:[...]}` for scripture. Heading jobs send `{items:[],heading:{projectUnitId,bibleTextId,pericopeNumber,pericopeSetId,suggestedText,modelInfo?}}`; mixed heading/scripture results are rejected. Heading text uses the same validator as authored headings: trimmed, 1–300 UTF-16 units, no backslashes or line breaks. A title result never writes scripture or markers. Results are cached once, scoped by project unit, first verse, selected set, and pericope identifier. Old-set results are rejected and old-set caches are never served for a new set.

Migration `0029_add_pericope_ai_suggestions` creates `ai_pericope_suggestions` and `ai_pericope_suggestion_usage`, with cascading references and uniqueness constraints. No existing translation data is rewritten.

## Validation

Unit and route tests cover gates, authorization, schema bounds, exact verse jobs, preservation, omitted titles, singleton behavior, submission failures, and heading context/results. The opt-in PostgreSQL suite applies the full migration history and checks real joins, source isolation, persistent cache uniqueness, monotonic usage, authored text preservation, and set changes.

Run the integration suite only with a disposable PostgreSQL database named `fluent394_api` bound to `127.0.0.1:55494`, supplying its URL in `PERICOPE_TEST_DATABASE_URL`. The suite refuses any other database target. It creates fixture data only inside that disposable database.
