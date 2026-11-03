# Working Passage Assistant

## Scope and status

This coordinated API/Web implementation covers the Assistant shell (#402), passage briefing and
suggested questions (#404), and temporary conversation (#406). The implementation is submitted for review with the limitations below; production ship gates remain open. It does not establish product/SME approval,
production readiness, QA sign-off, or deployment.

Related requirements: fluent-web [#402](https://github.com/eten-tech-foundation/fluent-web/issues/402),
[#404](https://github.com/eten-tech-foundation/fluent-web/issues/404), and
[#406](https://github.com/eten-tech-foundation/fluent-web/issues/406).
Settings [#403](https://github.com/eten-tech-foundation/fluent-web/issues/403) and first-use notice
[#407](https://github.com/eten-tech-foundation/fluent-web/issues/407) remain outside this increment.
Durable conversation history, attachments, automatic draft access, generated edits/actions,
background agents, dynamic MCP, and additional providers are also excluded.

## Current limitations and follow-up

Earlier November 3 probes observed BT Servant 2.59.0 buffering text until completion. The Fluent team is coordinating streaming restoration. Later local cold-briefing samples delivered first content in 7–14 seconds and completed in 23–35 seconds. These bounded samples demonstrate incremental delivery in those requests; they do not establish consistent streaming across every follow-up or deployment.

The pane now includes the agreed rounded border, single sparkle icon, quieter question buttons, compact expanding composer, and red error/Retry styling. An explicit prompt template requests a localized Suggested questions heading; three fresh English/Hindi samples followed that shape. Inline question placement remains model-controlled, and existing cache entries may retain the old shape. The language selector remains below the passage header as the written requirement specifies. Context-limit/interruption notices and conversation separators remain; the informational notice stays separate under #407.

## Architecture and user behavior

Fluent API authorizes project access, resolves the complete ordered canonical source-Bible pericope,
calls BT Servant directly, normalizes its bounded stream, and owns disposable completed-artifact
caches. There is no fluent-ai hop or generic provider framework. Web uses the API-owned supported
language inventory, saved language preference, and source-language/English fallback.

Language discovery is bounded and cancellable. A failed lookup retains the pane and offers explicit retry without inventing an English-only inventory. Invalid language configuration instead displays a persistent administrator-action message and emits a sanitized, once-per-process diagnostic. Assistant interface text uses the existing English/Hindi localization dictionaries independently of the selected answer language.

The Assistant tab precedes Resources and remains independent of translation AI opt-out. The pane
shows the canonical pericope header, language selector, briefing, suggested questions and conversation
in a shared scroll area, with a composer pinned below it. Generation and Retry have visible controls.
Safe Markdown is rendered from the accumulated source; unsafe HTML/URLs remain disabled. Complete
recognized question macros become buttons; unknown or malformed syntax remains inert text.

The prompt supplies an explicit template requesting two short briefing paragraphs, a separator, a localized Suggested questions heading, and three passage-specific questions in the selected language. Question count and placement are prompt conventions, not transport validation:
a safe receipt-consistent document remains readable even when the model deviates. Product/SME
acceptance must assess this limitation rather than infer compliance from parser tests.

A question button submits its exact visible text through the same action as Enter/Send and preserves
an existing unsent draft. Typed text is preserved apart from rejecting all-whitespace submissions;
IME composition does not submit. Typed submission waits for a complete briefing unless an early
suggested-question click has already established a signed frozen branch. The draft remains editable.

A new question during generation freezes the visible prefix and starts a separate branch. Later
output from the old attempt cannot alter that branch. Originally cacheable production may finish
and publish its completed artifact; originally private production remains no-write. BT serializes
work per user, so foreground interruption does not guarantee that the next answer starts immediately.
There is no cancellation or queue-bypass guarantee.

Retry belongs only to the latest failed/interrupted user turn, keeps the same logical question,
and excludes its failed attempt from provider history. A deliberate new question can include a
nonempty signed partial answer, explicitly marked incomplete. Empty failures produce no history pair.

One conversation owner lives for the drafting workspace, above panel remounts. Closing the sidebar
or switching to Resources/Checks preserves the thread/draft and lets an already requested answer
finish. Same-pericope verse navigation preserves it. Pericope/project changes, language/grounding
changes, and Force fresh create a new boundary; A→B→A does not restore the earlier thread. Unresolved
navigation disables stale interactions until canonical context is known. Reload, logout and workspace
exit discard the conversation. A server context change refreshes the briefing and restores the pending
question as an unsent draft requiring deliberate resubmission.

New briefing generation starts while the pane is open. After a current foreground completion,
Web may touch exactly the next pericope; historical completions do not trigger it and it never
recurses. This optimization has provider cost and can compete for the same user's queue slot.

## Data flow and integrity

Briefing requests contain canonical selectors, output language and bounded diagnostic choices.
Turn requests additionally contain the frozen briefing, bounded ordered visible exchanges, signed
context/output receipts and the explicitly submitted message. API does not accept browser-selected
provider identity, credentials, source Bible wording, system policy or automatic editor context.

The API sends the exact reference-labelled configured source passage to BT Servant, together with
the frozen briefing, projected history, and the current typed or suggested question. Text deliberately
pasted into the Assistant, including draft translation, travels as user input. The Assistant does
not automatically read or attach the target editor. Therefore neither “references only” nor an
unqualified “draft text is never sent” accurately describes this capability.

The API derives stable `fluent_{userId}` from the authenticated numeric Fluent user id for BT's
queue/history slot; the browser cannot select it. Activity is linkable across provider requests.
That identity is excluded from semantic artifact keys and does not grant Fluent authority.

`POST /projects/{projectId}/assistant/turns` repeats project authorization and canonical resolution
before cache/provider access. HMAC-SHA256 receipts with a dedicated configured key bind authenticated
actor and canonical context, including source content/references, language, resource scope and semantic
versions. Each visible output prefix has a signed exact-source, sequence, completeness and logical
branch binding. Web commits text and receipt together. API verifies the full submitted branch before
projecting history; tampering, reordering, omitted middle exchanges and incompatible branches cannot
be promoted to trusted assistant output. Receipts are integrity evidence, not access permission.

Cached artifacts contain no actor-specific receipts. Authorized deliveries receive fresh receipts;
cache eviction does not invalidate an otherwise valid conversation. Missing receipt configuration
makes turns unavailable while briefing remains usable. Key rotation deliberately invalidates previous
receipts and requires a new briefing. Cache TTL is not a receipt lifetime. Keys and receipts are not
logged.

The concrete BT client receives API-built history, suppression flags and trusted operation/language
instructions preceding labelled JSON user data. Literal user `#mode`/`@language` text is data rather
than a leading transport command; this does not claim to solve model prompt injection generally.

The canonical passage, selected language, grounding policy and frozen briefing appear in every
current provider message independently of the retained history window. After full transcript
verification, the newest whole nonempty exchanges are retained in chronological order. Default
`ASSISTANT_HISTORY_WINDOW` is five pairs, configurable from 1–50 and required to match the deployed
provider configuration. Omitted-turn metadata drives the visible reduced-context notice. The full
local transcript remains visible; there is no automatic summary or silent per-message truncation.
Mandatory context that cannot fit returns `context_too_large` and preserves pending input.

## Bounded contract and operations

| Bound                                          | Turn contract maximum                    |
| ---------------------------------------------- | ---------------------------------------- |
| Raw request / serialized submitted turns       | 524,288 / 393,216 bytes                  |
| Logical user turns / attempts per turn         | 50 / 4                                   |
| Current input                                  | 4,000 characters and 16,000 UTF-8 bytes  |
| Generated answer                               | 15,000 characters and 60,000 UTF-8 bytes |
| Receipt                                        | 4,096 characters                         |
| Canonical source / constructed current message | 32,000 / 48,000 bytes                    |
| History field / serialized provider history    | 16,000 characters / 524,288 bytes        |
| Frame                                          | 1,048,576 bytes                          |
| Connect / idle / total                         | 10 / 45 / 180 seconds                    |

Configured provider budgets may tighten these ceilings; the current message must also fit the
configured input budget. Admission bounds apply before expensive receipt verification/provider use.
A content-free SSE comment heartbeat every 15 seconds keeps the Web transport active while the
upstream 45-second idle and 180-second total budgets still apply. Blank completions are rejected,
not cached; pre-existing blank cache rows are ignored. There are no automatic retries.
Only explicit validated completion means success; partial output
stays readable on failure. Shared request/error logging uses content-free metadata and generated
request ids rather than inbound identifiers or raw exceptions.

## Artifact cache and retention

Briefings and follow-up artifacts use distinct versioned storage; migration `0042` adds completed
turn artifacts. Keys hash authorized canonical scope, exact normalized provider projection and
answer-affecting policy/configuration. Execution ids, timestamps, signatures and user identity are
excluded. Only successful completed generated Markdown and minimal version metadata are stored,
with database-clock seven-day expiry, first-winner publication, bounded cleanup and shutdown.
Inputs/transcripts, raw source blocks and receipts are not separately stored in these tables.
Generated answers can quote source text or explicitly pasted input.

For turns, `dont_cache` defaults true. An exact completed authorized match may still be read;
a miss runs privately without joining or publishing a shared producer. False permits process-local
same-key joining and successful-completion publication. Web sends false only for the first pristine
suggested question after a completed briefing, before typed/partial interaction or earlier turns.
Later suggestions, typed messages and partial branches are no-write. This hint is not authorization.
The briefing debug `ignore_cache` bypass is different: it skips reads, joining and writes.
Cross-replica miss duplication remains possible; no distributed coordinator is introduced.

Conversation state exists only in browser memory, not localStorage, IndexedDB or briefing query data.
Clearing the pane is not a promise to erase generated artifacts or external provider copies.
Historical staging inspection found source-bearing questions and generated answers retained in BT
per-user history despite `suppress_memory: true`. Inspected provider code also permitted bounded
console/tail conversation records and a scrubbed downstream analytics path; a separate OTLP path
recorded lengths. Deleting/replacing history did not establish deletion of those other copies.
Current production retention/deletion terms still require owner confirmation.

## Historical spike evidence — October 2026

These observations belong to the original briefing spike, not current conversation acceptance.
The proposal was introduced on 2026-10-20 at `a31eae0`, clarified at `8181580`, and updated for
provider identity on 2026-10-27 at `7ec60d5`. Those dated identities remain historical facts.

- Initial loose prompts took 34.9–108.4 seconds to first content and 72.2–146.7 seconds to complete.
- The two-short-paragraph shape reduced one cross-chapter comparison from 108.4 to 30.0 seconds
  first content and from 146.7 to 46.1 seconds completion.
- Two same-hash observers joined one producer: about 34.7 seconds first content, 49.0 seconds
  completion, and one completed database row. Immediate PostgreSQL hits took 28–110 milliseconds.
- Six seven-day artifacts occupied 16,812 Markdown bytes; PostgreSQL reported 10,592 row bytes.
- An abort-then-navigate successor waited 64.8 seconds for first content and 80.0 seconds to finish.
  Two distinct Fluent users overlapped with first content around 36.5–37.5 seconds.
- English/English, Hindi/Hindi, and Hindi-output/English-resource samples completed with three
  recognized question macros and separated resource language from visible output language.
  Citation specificity varied; plausible confident synthesis still required qualified review.
- The 2026-10-27 post-rebase sample recorded 71 ms acknowledgement, 32.476 seconds first content,
  and 44.810 seconds completion; an immediate repeat completed in 70 ms. These are samples, not SLAs.

## Current acceptance evidence — 2026-11-01

Current local heads are API `a3659ac` and Web `af638a88`. The following acceptance contact was
completed on 2026-11-01; conversation/interruption provider samples were captured before the final API heartbeat/blank-output
correction (`cc0bd3b`) and dead-code cleanup (`a3659ac`). The cold/warm briefing check below
was subsequently run at the corrected head; earlier samples are not relabelled as final-head runs.

- Authenticated local Web → API → BT completed seven turns. The first suggested answer reused a
  completed artifact in 33 ms; six typed turns were no-write. The seventh submitted all six prior
  turns, projected five exchanges, and reported one omitted exchange. Passage-speaker grounding
  and the frozen briefing were preserved; no transcript appeared in local/session storage.
- English and Hindi briefing samples each had two paragraphs before three questions. Hindi
  contained Devanagari; changing language cleared the previous question and survived reload.
  These samples do not establish general output conformance or language/SME quality approval.
- An interruption froze a two-byte signed visible prefix. The next no-write turn acknowledged in
  40 ms, first content arrived at 1,859 ms and completion at 2,192 ms. The idle comparison was
  37 / 1,817 / 2,310 ms: a 42 ms first-content difference in this single sample. It does not establish
  a typical queue penalty or guarantee. The original cacheable producer subsequently yielded a
  5,615-byte completed artifact, replayed in 134 ms without rewriting the interrupted branch.
- Deterministic browser checks covered hidden completion, same-pericope preservation, hidden
  boundary reset, A→B→A, language change during streaming, exact-prefix interruption, early macro
  pinning, late-event fencing, Retry, IME/exact text, draft preservation, reload and context reset.
  Normal/narrow pane checks covered shared scrolling and pinned-composer fit at 352 and 248 pixels.
- Deleting the matching briefing cache row did not invalidate an existing signed conversation:
  a subsequent private turn completed in 3,464 ms with passage grounding. The turn-artifact count
  remained three before and after, demonstrating no write for that request.
- Runtime API logs over the sampled 45-minute window contained none of three synthetic submitted
  inputs, receipt fields or request authorization headers. This bounded check supplements static
  logging/storage/data-flow inspection; it does not establish provider-side deletion or retention.
- Final Web normal gates passed with 2,178 tests, static checks and production build. Final branch
  rebase was a no-op. Fresh disposable full-chain PostgreSQL migration and app boot passed;
  the disposable database was removed.

Final corrected API `a3659ac` passed dependencies, lint, formatting, type checking and tests:
1,871 passed, 16 skipped. The combined gate runner was terminated (exit 143) during build; a
standalone production build on pinned Node 24.14 completed with exit 0. Independent dead-code
checking retained the 154-entry baseline with no new entries. Web `af638a88` passed all normal
gates and production build with 2,178 tests. Correction review passed eight focused tests; fresh
assembled independent review of corrected code, evidence and this package was CLEAN with no findings.

A final corrected-head authenticated cold/warm briefing check completed with identical 2,119-byte
Markdown, two paragraphs and three question macros. Cold acknowledgement/first content/completion
were 41 / 14,067 / 28,623 ms; warm values were 149 / 167 / 167 ms with explicit `cacheHit:true`.
This final-head briefing check is distinct from the earlier seven-turn and interruption samples.

## Production ship gates

Implementation acceptance does not close the following decisions:

- Product and Bible-translation SME approval of resource subset, citation/attribution rubric,
  briefing/question shape, real narrow-pane interaction, and dynamic-translation quality/disclosure.
- License permission for each configured Bible's exact text through Fluent → BT Servant →
  Cloudflare/Anthropic; ownership and implementation of any source/license eligibility gate.
  If required, eligibility must be checked before in-flight or completed cache lookup.
- Confirm production operator/controller/processor relationships, hosting accounts, retention and
  deletion, incident obligations and disclosures. Shared ETEN mission context does not establish
  one legal entity or shared production accounts; BT is partner-operated in unfoldingWord custody.
- Accept the stable raw-derived provider identifier or require a server-secret keyed stable mapping.
- Approve Settings/notice/privacy/ToS/help copy that names canonical-source, stable-identifier and
  explicit-message transmission, distinguishes no automatic editor access from pasted input,
  and distinguishes pane clearing from cache/provider retention. #403/#407 are not completed here.
  Material future draft access or retention changes require reviewing copy and notice re-display.
- Decide whether a later project-manager language default/restriction is needed.
- Assign credential/receipt-key/configuration owners, match the deployed history window, authorize
  deployment, and approve monitoring thresholds, retention/deletion statement, rollout and rollback.

The feature flag remains the deployment boundary until these gates close. API and Web are
coordinated PRs; this document is the shared design narrative rather than a second provider framework.
