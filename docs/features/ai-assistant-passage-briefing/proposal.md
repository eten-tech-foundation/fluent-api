# AI Assistant Passage Briefing Spike

## Status

This is a code-bearing spike proposal, not production approval. It demonstrates one concrete
BT Servant-backed passage briefing across Fluent API and Fluent Web. Product, Bible-translation
SME, licensing, privacy, and production-operations decisions listed below remain open.

Related work: fluent-web
[#402](https://github.com/eten-tech-foundation/fluent-web/issues/402) and
[#404](https://github.com/eten-tech-foundation/fluent-web/issues/404). The spike does not complete
[#403](https://github.com/eten-tech-foundation/fluent-web/issues/403),
[#406](https://github.com/eten-tech-foundation/fluent-web/issues/406), or
[#407](https://github.com/eten-tech-foundation/fluent-web/issues/407).

## Proposal

Keep the first implementation deliberately concrete:

- Fluent API authorizes the project request, resolves the canonical source-Bible passage, calls
  BT Servant directly, normalizes its stream, and owns the disposable completed-artifact cache.
- Fluent Web requests the briefing only while the Assistant pane is open, renders safe Markdown and
  exactly three inline suggested-question widgets, isolates stale navigation results, and touches at
  most the next pericope after the current result completes.
- Do not introduce a reusable AI-backend interface from this single implementation. A second real
  backend should supply the evidence for any shared boundary.

The proposed shape is requested, read-only assistance. It does not add freeform conversation,
durable Assistant history, draft-aware analysis, generated edits, background agents, dynamic MCP,
or a generalized prefetch scheduler.

## Data boundary

The browser sends only these selectors and bounded choices:

- project id, book code, chapter, and active verse;
- output language;
- a debug-only grounding-resource choice when the local force-on control is active; and
- a cache-bypass flag when explicitly selected in the local debug controls.

Fluent API checks project access before resolving the complete ordered pericope from the project's
configured source Bible. It places the exact reference-labelled canonical source wording in the BT
question. Target-editor/draft text is not read by the Assistant request path and is not included in
the browser request, BT question, Assistant cache, Assistant logs, fixtures, or telemetry.

The distinction matters: this spike sends more than passage references. Existing or proposed copy
that says the Assistant “uses only passage references” is inaccurate. The accurate statement is
that it sends the configured canonical source passage and does not send the translator's target
draft.

Fluent stores only the completed generated Markdown and version/language metadata in the disposable
cache. It does not separately store the source block or prompt. The cache key is a SHA-256 digest of
the answer-affecting semantic inputs, including the exact source wording; the digest prevents reuse
after a source change but does not grant permission to transmit the source.

## Demonstrated behavior

### Streaming and presentation

- The direct BT-specific client reconstructs arbitrary SSE splits, bounds connection/idle/total time,
  frame size, input size, and output size, and accepts completion only when the final receipt agrees
  with the streamed document.
- Browser-visible failures use a small Fluent vocabulary and do not expose BT errors, prompt text,
  source text, cache keys, or generated content in logs.
- The Web client validates every normalized event, waits for clean EOF, rerenders the complete
  Markdown source after each delta, rejects unsafe HTML/URLs, and renders malformed or unknown widget
  syntax as inert text.
- Real browser navigation with overlapping requests kept the newly selected pericope visible. The
  older cacheable request completed into its own cache entry without replacing current content.

### Language and grounding

Staging inventory exposed both English and Hindi resources; inventory alone does not establish
coverage, approval, or quality. Controlled English/English, Hindi/Hindi, and Hindi-output/
English-resource runs all completed and preserved exactly three widget macros.

Observed runs separated resource and output language as intended:

| Case                               | Observed tool-language marker | Visible output                                              |
| ---------------------------------- | ----------------------------- | ----------------------------------------------------------- |
| English resources / English output | `en`                          | English, with identifiable English resource ids             |
| Hindi resources / Hindi output     | `hi`                          | Devanagari, with identifiable Hindi resource ids            |
| English resources / Hindi output   | `en`                          | Devanagari, retaining identifiable English-source citations |

This is engineering evidence that the controls work. It is not a finding that the selected resource
subset is approved, that every claim is properly grounded, that Hindi is natural or theologically
precise, or that approval survives dynamic translation. Citation specificity varied, and samples
included plausible but confident synthesis that requires qualified review.

The API publishes its supported Assistant output-language inventory. Normal requests use the
server-configured grounding mapping. The three-way grounding selector—configured behavior,
same-as-output, or English resources—is local force-on diagnostics only, not a production user
preference.

### Latency, cache, and prefetch

The sample is engineering evidence, not an SLA or latency distribution.

- Initial loose prompts took 34.9–108.4 seconds to first content and 72.2–146.7 seconds to complete.
- The selected two-short-paragraph shape, with deeper work reserved for three questions, reduced one
  cross-chapter comparison from 108.4 to 30.0 seconds for first content and from 146.7 to 46.1 seconds
  for completion. Cold latency remains material.
- Two simultaneous same-hash requests joined one process-local producer: first content at about
  34.7 seconds, completion at about 49.0 seconds, one completed database row.
- Immediate PostgreSQL hits completed in 28–110 milliseconds. Only a real completed-row hit is
  labelled `cacheHit`; latency is not used to infer a hit.
- Cache bypass performs no read, join, or write and does not replace the normal winner. Failure,
  interruption, and incomplete output do not create a durable artifact.
- A seven-day completed-artifact sample occupied 16,812 Markdown bytes across six rows; PostgreSQL
  reported 10,592 bytes of row storage for those rows.
- Process-local joining does not eliminate a cross-replica miss race. The evidence does not yet
  justify distributed coordination.

After a current foreground completion, Web may touch exactly the next pericope. Historical
completions do not trigger it, and prefetch does not recurse. This bounded optimization can make the
next navigation warm, but it has a real provider cost and can delay same-user work because BT
serializes a user slot. In one abort-then-navigate observation, the successor waited 64.8 seconds for
first content and 80.0 seconds to finish. Two distinct Fluent users ran in overlapping BT slots,
reaching first content at about 36.5–37.5 seconds.

The recommendation is to retain lazy generation, completed-artifact reuse, process-local same-hash
joining, and the one-next-pericope touch for a measured production trial. Do not add broad prefill,
a cross-key scheduler, distributed locking, or identity pooling without new evidence.

## Privacy, retention, and licensing

BT Servant staging persisted the source-bearing question and generated answer in per-user history
despite `suppress_memory: true`. The deployed code also permits conversation text in bounded
console/tail records and a scrubbed downstream analytics path; a separate OTLP path records lengths
rather than text. Deleting or replacing BT history has not been proved to delete console/tail or
downstream copies.

Public evidence places Fluent and BT Servant in the same ETEN mission ecosystem, while BT Servant is
in unfoldingWord's technical custody and uses Cloudflare and Anthropic. That evidence does not prove
one legal entity, one data controller, shared production accounts, or applicable retention and DPA
terms. Treat this as an ETEN-ecosystem integration between partner-operated services until the
responsible owners confirm otherwise.

Before production shipment, the responsible product/legal/privacy and Paul/Peter-area stakeholders
must confirm:

1. whether each configured source Bible license permits transmitting its exact text through the
   Fluent → BT Servant → Cloudflare/Anthropic processing chain;
2. the production operator/controller/processor relationship, hosting accounts, retention/deletion
   behavior, incident obligations, and required disclosure;
3. whether an eligibility flag is required in the source/license table and who owns it; and
4. corrected user-facing privacy and scope copy.

If a source-license eligibility gate is chosen, it must run before an in-flight or completed cache
lookup. A content hash cannot substitute for that authorization check.

## Product and SME decisions still open

- Approve the grounding-resource subset and citation/attribution rubric.
- Decide whether dynamically translated approved English resources retain their approval/confidence
  and whether the UI needs a translation disclosure.
- Review the two-short-paragraph/two-observation shape and the deeper-research role of exactly three
  question buttons in the real narrow pane.
- Decide whether Assistant output language later gets a project-manager default/restriction. If so,
  use a narrow merge-safe project metadata mutation; do not overwrite unrelated metadata or misuse
  global/user Settings.
- Finalize the interaction and notice copy for #402–#407. In particular, correct the “only passage
  references” statement before it ships.

## Production hardening and rollout

The spike already includes project authorization, fail-closed optional configuration, normalized
failures, bounded inputs/streams/timeouts, safe Markdown, completion-only cache writes, explicit
cache invalidation versions, bounded database admission, controlled shutdown, and content-free logs.

Production remains gated on the decisions above plus credential/configuration ownership, deployment
authorization, monitoring thresholds, a retention/deletion statement, and an owner-approved rollout
and rollback plan. The feature flag should remain the deployment boundary until those gates close.

The code should remain split into coordinated API and Web changes. One PR can carry this design
narrative and the other can link to it; duplicating or generalizing the architecture would obscure
the actual evidence.
