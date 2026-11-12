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
Durable conversation history, attachments, automatic draft access, generated passage edits,
background agents, dynamic MCP, and additional providers are also excluded. Generic declarative
action transport, prompting, parsing, and local dispatch are implemented, but only
`suggested_question` is registered; there is no generated passage-edit action or endpoint.

## Current limitations and follow-up

Earlier November 3 probes observed BT Servant 2.59.0 buffering text until completion. The Fluent team is coordinating streaming restoration. Later local cold-briefing samples delivered first content in 7–14 seconds and completed in 23–35 seconds. These bounded samples demonstrate incremental delivery in those requests; they do not establish consistent streaming across every follow-up or deployment.

The pane now includes the agreed rounded border, single sparkle icon, quieter question buttons, compact expanding composer, and red error/Retry styling. An explicit prompt template requests a localized Suggested questions heading; three November 3 English/Hindi samples followed that shape. Inline question placement remains model-controlled, and existing cache entries may retain the old shape. The language selector remains below the passage header as the written requirement specifies. Context-limit/interruption notices and conversation separators remain; the informational notice stays separate under #407.

## Architecture and user behavior

Fluent API authorizes project access, resolves the complete ordered canonical source-Bible pericope,
calls BT Servant directly, normalizes its bounded stream, and owns disposable completed-artifact
caches. There is no fluent-ai hop or generic provider framework. Web uses the API-owned supported
language inventory, explicit saved language preference, and source-language/English fallback. The inventory comes from operator configuration (`ASSISTANT_LANGUAGES_JSON`), not live BT discovery. Automatic defaults are not saved as preferences; existing preferences are retained because older stored values have no provenance marker.

Language discovery is bounded and cancellable. A failed lookup retains the pane and offers explicit retry without inventing an English-only inventory. Invalid language configuration instead displays a persistent administrator-action message and emits a sanitized, once-per-process diagnostic. Assistant interface text uses the existing English/Hindi localization dictionaries independently of the selected answer language.

The Assistant tab precedes Resources and remains independent of translation AI opt-out. The pane
shows the canonical pericope header, language selector, briefing, suggested questions and conversation
in a shared scroll area, with a composer pinned below it. Generation and Retry have visible controls.
Safe Markdown is rendered from the accumulated source; unsafe HTML/URLs remain disabled. Complete
recognized question macros become buttons in briefings and follow-up answers; unknown or malformed syntax remains inert text. Link/image metadata remains inert and preserves original directive text rather than internal parser placeholders.

The prompt supplies an explicit template requesting two short briefing paragraphs, a separator, a localized Suggested questions heading, and three passage-specific questions in the selected language. Question count and placement are prompt conventions, not transport validation:
a safe receipt-consistent document remains readable even when the model deviates. Product/SME
acceptance must assess this limitation rather than infer compliance from parser tests.

A question button submits its exact visible text through the same action as Enter/Send and preserves
an existing unsent draft. Typed text is preserved apart from rejecting all-whitespace submissions;
IME composition does not submit. An immediately rejected suggested question replaces that unsent
draft with the full question. After admission, terminal and `context_changed` recovery restores the
question only when the composer has not been edited since submission; newer edits are preserved.
Intermediate busy retries do not trigger recovery, and cancelled, superseded, or stale attempts
cannot replace a newer conversation's draft. Typed submission waits for a complete briefing unless
an early suggested-question click has already established a signed frozen branch. The draft remains
editable.

A new question during generation freezes the visible prefix and starts a separate branch. Later
output from the old attempt cannot alter that branch. Originally cacheable production may finish
and publish its completed artifact; originally private production remains no-write. One new upstream generation per authenticated user is admitted in each API process. Completed cache hits and joins of existing work are exempt. Retained generation holds admission through completion even when an observer disconnects. A foreground question may wait behind successor warming. This is not distributed admission; remote BT work surviving local cancellation can overlap later work. There is no provider cancellation or queue-bypass guarantee.

Retry belongs only to the latest failed/interrupted user turn, keeps the same logical question,
and excludes its failed attempt from provider history. A deliberate new question can include a
nonempty signed partial answer, explicitly marked incomplete. Empty failures produce no history pair.

One conversation owner lives for the drafting workspace, above panel remounts. Closing the sidebar
or switching to Resources/Checks preserves the thread/draft and lets an already requested answer
finish. Same-pericope verse navigation preserves it. Pericope/project changes, language/grounding
changes, and Force fresh create a new boundary; A→B→A does not restore the earlier thread. Unresolved
navigation disables stale interactions until canonical context is known. Reload, logout and workspace
exit discard the conversation. A server context change refreshes the briefing and, when the composer
is unchanged since submission, restores the pending question as an unsent draft requiring deliberate
resubmission.

New briefing generation starts while the pane is open. After a current foreground completion,
Web may touch exactly the next pericope; historical completions do not trigger it and it never
recurses. This includes read-only users, whose completed outputs can also benefit other authorized users. This optimization has speculative provider cost and can compete for the same user's generation slot; the read-only policy remains a product tradeoff.

## Data flow and integrity

Briefing requests contain canonical selectors, output language, and bounded diagnostic choices.
For any generation that can create, publish, or join a shared artifact, API supplies the fixed
server-owned `suggested_question` action catalog and ignores the client catalog for prompting. A
guaranteed no-write private turn may use Web's structurally bounded declarative catalog.
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

## Action catalog and semantic identity

Web owns generic action definitions and rendering/handlers. A private request may supply declarative
`type`, `purpose`, and `template` entries, never JavaScript. API validates a maximum of 32 entries and
32,768 serialized bytes, rejects duplicate types and unknown entry fields, and safely serializes the
bounded private catalog. Shared-capable briefing and turn generation instead use API's fixed canonical
`suggested_question` definition. Shared-capable initial briefings and cacheable pristine
suggested-question turns therefore cannot be changed by a client-supplied catalog.

The existing `{{fluent:v1:suggested_question|QUESTION}}` macro is preserved. Web dispatches only recognized actions to local behavior after a user click. Follow-up output carries the widget contract separately from the turn transport protocol. Unknown/malformed output remains inert. There is no BT contract negotiation or acknowledgment mechanism in this increment.

The generation identity is one canonical object containing the exact provider-visible current message,
exact provider-visible history, exact response-language hint, output-validity and contract constraints,
cache epoch, and an artifact-kind hash-domain separator. Its fingerprint is both the shared artifact
key and the signed turn projection digest. User, project, and organization identity, endpoint,
operation/request/receipt identifiers, and transport timing do not enter it. A separate receipt MAC
continues to bind the authenticated actor and authorized context and prevents history tampering and
cross-user reuse.

Provider-request construction consumes that same canonical object. An exact prompt, history, language,
output constraint, kind, or epoch change intentionally produces a cold cache. There is no separate
catalog digest: a catalog matters only through the exact provider prompt in the canonical generation
input. The server canonical catalog protects shared generation, while bounded client catalog changes
affect only guaranteed no-write private generation.

A future syntax change can use expand/migrate/contract: support both forms in Web, teach the new form, retire old cached output safely, then remove old rendering support. Do not rewrite serialized output covered by a signature or digest without addressing that binding; purge/epoch is an alternative.

## Bounded contract and operations

| Bound                                              | Turn contract maximum                                           |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Raw request / serialized submitted turns           | 524,288 / 393,216 bytes                                         |
| Logical user turns / attempts per turn             | 50 / 4                                                          |
| Current input                                      | 4,000 characters and 16,000 UTF-8 bytes                         |
| Current answer emergency ceiling                   | `ASSISTANT_MAX_OUTPUT_BYTES`: 8 MiB default, 32 MiB maximum     |
| Total retained normalized stream emergency ceiling | `ASSISTANT_MAX_RETAINED_BYTES`: 64 MiB default, 256 MiB maximum |
| Receipt                                            | 4,096 characters                                                |
| Canonical source / constructed current message     | 32,000 / 48,000 bytes                                           |
| History field / serialized provider history        | 16,000 characters / 524,288 bytes                               |
| Upstream BT frame                                  | `ASSISTANT_MAX_FRAME_BYTES`: 1 MiB default, 8 MiB maximum       |
| Emitted whole SSE frame                            | 202,375,168 bytes (6 × 32 MiB answer + 1 MiB envelope reserve)  |
| Connect / idle / total                             | 10 / 45 / 180 seconds                                           |

Configured provider budgets may tighten these ceilings; the current message must also fit the
configured input budget. Admission bounds apply before expensive receipt verification/provider use.
A content-free SSE comment heartbeat every 15 seconds keeps the Web transport active while the
upstream 45-second idle and 180-second total budgets still apply. Blank completions are rejected,
not cached; pre-existing blank cache rows are ignored. Web automatically retries only explicit pre-stream `generation_busy` admission failures with bounded backoff and cancellation. It preserves the pending message and normal waiting UI until admission succeeds or the retry budget expires. Already-started streams are not automatically replayed.
Only explicit validated completion means success; partial output stays readable on failure. Recoverable passage-context failures offer Retry; non-retryable failures provide localized next steps. All Assistant interface text uses the existing localization machinery.

Production unhandled-error logging retains method/path/status instead of raw exceptions. Unknown or
malformed upstream frames may log content-free event/type metadata such as reason and `textType`,
never payload or content. Any logged event-type value is bounded to 64 UTF-8 bytes including its
suffix; truncation reserves the final three bytes for ASCII `...` and stops on a Unicode code-point
boundary. Valid comments and empty frames do not warn. Unused legacy request-ID/logger additions have
been removed; production HTTP request-correlation integration is not part of this change. Independent
canonical lookup work runs concurrently; dependent source reads preserve ordering.

## Artifact cache and retention

Migration `0041_assistant_artifacts` remains unchanged as dated evidence. Generator-created
`0042_assistant_artifacts` creates one `assistant_artifacts` table and drops the old briefing and turn
tables. Application code supplies one generic repository for eligible briefing and turn artifacts. The
unified row has exactly `cache_key`, `markdown`, `cache_epoch`, `output_contract_version`,
`completed_at`, and `expires_at`. `cache_key` is the sole lookup identity; epoch and contract are stored
cleanup tags and are checked after lookup before replay. Publication remains first-winner with
database-clock expiry, bounded cleanup, and shutdown.

The migration deliberately performs no data migration or legacy lookup. QA accepts a cold artifact
cache and ephemeral receipt reset, and repopulation occurs through normal authorized generation. A
shared artifact is eligible only when the exact provider input contains no user-authored,
user-identifying, tenant-private, or pasted private material. API never hashes a scrubbed variant while
sending private input; generic or private conversation generation remains no-write.

For turns, `dont_cache` defaults true. An exact completed authorized match may still be read;
a miss runs privately without joining or publishing a shared producer. `dont_cache: false` is
insufficient to grant shared access. API must prove that the submitted text exactly matches a
`suggested_question` action in the signed complete canonical briefing and that this is the pristine
first turn, before it may read, join, or publish. Client origin labels are not proof. Later suggestions,
typed messages, partial branches, and any failed proof are no-write. The briefing debug `ignore_cache`
bypass is different: it skips reads, joining, and writes.
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

## Historical acceptance evidence — 2026-11-01

The November 1 local heads were API `a3659ac` and Web `af638a88`. The following acceptance contact was
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

## Correction validation — 2026-11-05

Code checkpoint: API `f5267e9477ef10e7eb4d2632c900de57d9a3e754`, Web `856ef1e5a43929a2361dd2b09c3af69959c4ed5b`. API verify/build passed with 1,968 tests and 16 skips; Web precheck/build passed with 2,237 tests. The consolidated migration was executed independently against the original pair and final schema equivalence passed. Both branches were zero commits behind main at this checkpoint.

Deterministic browser checks passed for initial/follow-up catalogs and buttons, transparent busy retry, full failed-question recovery, hidden same-pericope retention, boundary reset, A→B→A, and language-change late-output fencing. These checks did not call BT or establish live provider streaming/quality. Earlier provider samples retain their original dates and limits.

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

Feature flags advertise Web visibility, consistent with the existing advertise-only policy; they are not API authorization or provisioning gates. The merged Web flag gates queries and warming. Local Force on allows QA of a provisioned feature before global advertisement. API authentication and project/resource authorization still apply; missing provisioning returns the corresponding error. Debug bypass remains available to otherwise authorized users so QA can exercise their real resource permissions, and per-user generation admission applies. A hidden debug page is not a security boundary. A separate deployment-password gate is only a discussion option and is not implemented.

If pericope data does not cover the current verse, the exact-current-verse fallback remains unchanged pending product feedback. Whole-chapter fallback, or a minimal missing-context diagnostic, are discussion options; the nearest preceding pericope can omit the selected verse. The normal same-pericope retention guarantee remains, but uncovered-verse navigation can reset the conversation.

API and Web are coordinated PRs; this document is the shared design narrative rather than a second provider framework.

### Retractable provider progress

BT progress appends Markdown; a `retract` replaces only the current assistant answer with an
empty string. Optional `iteration` and `chars` metadata never control retraction. Complete is
authoritative: a different final answer emits one full replacement before completion. Matching
completion emits none. Initial `briefing_replace` and follow-up `turn_replace` carry `markdown`
and the next signed sequence/receipt, committing the new full state immediately. Earlier turns,
questions and composer drafts remain intact. Existing actor-bound signed snapshots remain valid
after later replacements, including an interruption request already in flight.

Shared producers retain all ordered normalized events, including discarded text and empty
replacements, for late subscribers. Completed cache artifacts contain only final Markdown.
Current-answer bytes are measured after replacement; retained bytes include serialized normalized
events (including completion), without compaction. There is no character-count answer limit.
The configurable emergency ceilings above are deliberately far beyond normal answers. Web uses
the API configuration maxima, so it cannot impose a stricter answer ceiling. Frame and duration
bounds remain independent. A `response_safety_limit` terminal preserves visible partial output
and shows a localized warning that it may be incomplete and repeated failures should be reported
to the deployment administrator. This is distinct from oversized input/context. Diagnostics include
only byte counts, ceilings, provider and metadata-validity flags, never answer or diagnostic text.

### Incremental snapshots and emitted framing

Append accounting scans only new text and adjusts UTF-8 size for surrogate pairs split across
deltas. Replacements reset accounting once. Streamed receipts sign a domain-separated SHA-256
digest of exact UTF-16LE code units, marked by authenticated `outputDigestAlgorithm:
"sha256-utf16le-v1"`. Hash-state copies produce exact prefix snapshots in constant work per
commit; replacement starts a new hash. Lone surrogates remain distinguishable. Receipts without
the marker retain the original canonical-JSON digest verification, and their canonical serialization
is unchanged. Old valid snapshots therefore remain usable after newer receipts are issued.

The emitted-frame ceiling counts the entire UTF-8 SSE frame, including JSON escaping, id/event/data
fields and its terminating blank line. The factor of six covers worst-case JSON control-character
escaping; the 1 MiB reserve covers bounded identity, receipt and metadata overhead. API serialization
and Web parsing use the same 202,375,168-byte limit, independent of the configurable BT frame ceiling.
Web HTTP JSON responses remain separately capped at 1 MiB. Both parsers scan only new fragments
and assemble a full frame once, rather than rescanning a growing partial frame.
