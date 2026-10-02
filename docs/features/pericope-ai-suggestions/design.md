# Pericope AI suggestions

Supports [fluent-web#394](https://github.com/eten-tech-foundation/fluent-web/issues/394). Depends on the `markers.headings` storage contract in [fluent-api#320](https://github.com/eten-tech-foundation/fluent-api/pull/320).

The editor queues the active and next pericope by their source identifiers. The API resolves each identifier against the project's selected pericope set, source Bible, book, and chapter assignment. It queues individual source verses whose translation is absent or blank and whose suggestion is not already cached. Verse 1 and saved empty rows participate. Nonempty translations remain untouched.

Groups with a nonempty source title may also queue a heading-only job, but only when the group's first source-backed verse is the first verse of that pericope in the selected set. A chapter that continues an earlier pericope gets verse suggestions without a duplicate title. Missing source text for the true first verse also suppresses titles until that verse arrives. A heading is omitted when the first target verse already has authored `markers.headings`, or when a title suggestion is cached. Title jobs use distinct singleton keys including the selected set and exact source range. Existing scripture job keys and payloads remain compatible.

## Chapter boundary

Prefetch follows the existing verse-mode `queue-next` behavior from fluent-web#417: the active and next pericope are queued within the current chapter. When the active group is the last one in the chapter, no next-chapter request is made in advance. The editor queues that chapter's active and next groups when the translator enters it. Cross-chapter prefetch is not implemented by this change.

## Public HTTP contract

Use the exact `pericopeNumber` returned by the chapter pericopes endpoint. Sets with sections use a compound identity such as `1_4a`; this keeps two sections that reuse the same raw pericope number separate.

- `POST /ai-suggestions/queue-pericopes`: `{projectUnitId,bibleId,bookCode,chapterNumber,pericopeNumbers:string[]}` → `{queued,thresholdMet}`. Accepts 1–2 unique identifiers, each 1–100 characters without commas. Chapter assignment AI enablement and the existing activation threshold control queuing. Invalid batches queue nothing. Queue submission failures return an error; singleton deduplication is successful submission.
- `GET /ai-suggestions/pericopes`: the same fields in the query; `pericopeNumbers=4a,4b` is a comma-separated string. Returns `{data:[{pericopeNumber,bibleTextId,suggestedText,modelInfo?}]}`. `bibleTextId` identifies the true first verse of the pericope in the selected set. Continuations, groups whose first source verse is still missing, groups without source titles, and authored headings return no title. An assignment with AI off returns an empty title list; the editor keeps already-populated verse and heading draft state and stops filling new inputs.
- `POST /ai-suggestions/pericopes/usage`: `{projectUnitId,bibleTextId,pericopeNumber,wasUsed}`. A matching persisted suggestion must exist. The current set is preferred; if it has no saved suggestion, the newest saved set is used so a title shown before a set change can still be accepted. Exposure (`false`) and acceptance (`true`) are recorded separately from verse suggestion usage. Once accepted, a delayed exposure cannot change the record back to false.

All public endpoints reuse authenticated project access and `project:view` checks. Source verse IDs and title text are resolved on the server, never supplied by the browser.

## Worker HTTP contract

Existing trigger/context fields remain required. Optional `pericopeNumber` selects a heading-only job, and API-generated jobs also include `pericopeSetId`. Heading context validates the exact server-derived range and current set. Set changes, range backfills, missing groups, or a title that is no longer eligible return HTTP 200 with `sectionHeading: null`, empty `sourceVerses` and `contextVerses`, and an empty `targetLanguageName`; no model context is fetched. Missing paired set/group fields still fail request validation. The response adds `sectionHeading:{pericopeNumber,pericopeSetId,bibleTextId,sourceTitle}` or `null` when title generation no longer applies. `sourceVerses` is ordered and limited to exact pericope membership, including for sparse ranges. The worker treats `sectionHeading:null` as a successful no-op.

`POST /ai-suggestions/internal/results` continues accepting `{items:[...]}` for scripture. Heading jobs send `{items:[],heading:{projectUnitId,bibleTextId,pericopeNumber,pericopeSetId,suggestedText,modelInfo?}}`; mixed heading/scripture results are rejected. Heading text uses the same validator as authored headings: trimmed, 1–300 UTF-16 units, no backslashes or line breaks. A title result never writes scripture or markers. Results are cached once, scoped by project unit, source Bible, selected set, book, chapter, and pericope identifier. A result generated under an earlier set is stored under that set, and old-set caches are never served for a new set.

Migration `0032_add_pericope_ai_suggestions` creates `ai_pericope_suggestions` and `ai_pericope_suggestion_usage`, with cascading references and uniqueness constraints. No existing translation data is rewritten.

## Validation

Unit and route tests cover gates, authorization, schema bounds, exact verse jobs, preservation, omitted titles, singleton behavior, submission failures, stale heading jobs, and heading results. The repository integration suite runs in the normal Vitest command using in-memory PGlite, with tables, constraints, and indexes generated from the production Drizzle schema. It checks real SQL joins, chapter continuations, section-qualified identities, missing first source verses, source isolation, cache uniqueness, monotonic usage, authored text preservation, and set changes. It does not need a database URL or connect to a developer database.
