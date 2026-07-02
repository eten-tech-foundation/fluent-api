# Feature Flags — Review Summary

**Status:** Draft for review. Not yet implemented.

**Purpose:** Reviewer orientation for a lightweight feature-flag mechanism. The
full design is in the sibling [`feature-flags-suggestion.md`](feature-flags-suggestion.md)
(problem, design, decisions **D1–D8**, open questions **Q1–Q4**). Ships as a
coordinated pair of PRs — fluent-api (flag source + endpoint) and fluent-web
(consumer hook, gate primitive, diagnostics page).

## The problem

fluent-ai is **not hosted** in any deployed environment. Every PR that depends on
it therefore can't merge — doing so would surface UI whose backend isn't there
and block promoting to production, which stalls unrelated work queued behind it.
We need to **turn AI-dependent front-end features on/off per environment** so
their PRs can merge and ride to production **hidden**, then be switched on later
(where fluent-ai actually runs) with a config change and no code redeploy. This
is a **wiring/deploy concern**, not application data.

## What's being proposed

1. **Env-sourced flags, one flat var per flag** under a specific `EN_FEATURE_*`
   prefix (e.g. `EN_FEATURE_REPEATED_WORD_CHECK`), each **declared explicitly in
   the Zod env schema** — the schema doubles as the authoritative flag catalog
   and survives Zod's unknown-key stripping. No database (**D1, D2**).
2. **A read-only endpoint `GET /config/features`** — a new unauthenticated meta
   route (sibling of `/health`) returning a **named map**,
   `{ features: { repeatedWordCheck: true } }`, assembled from the `EN_FEATURE_*`
   vars (prefix stripped, camelCased). New flags are purely additive (**D3, D4**).
3. **fluent-api owns the truth, publishes a projection.** The env is the single
   source of truth; the endpoint is the publication channel, not a second
   source. fluent-web never decides policy — it only reflects.
4. **Safe default.** The repeated-word-check flag defaults **off** unless
   `FLUENT_AI_URL` + `FLUENT_AI_KEY` are both wired, so forgetting to set it in
   an AI-less environment yields the safe answer (**D2**).
5. **fluent-web consumes it** via a small extensible primitive — a
   `useFeatureFlags()` TanStack Query hook + a `<FeatureGate>` wrapper over a
   `Record<name, boolean>`. Gated AI UI **fails closed (hidden)** while loading
   or on endpoint error (**D6, D7**).
6. **An unlinked, login-gated, read-only diagnostics page** (a `chrome://`-style
   catch-all for technical/health details, starting with the flag map). Reuses
   the existing `_authenticated` gate; no role check (**D8**).

## Explicitly out of scope

- **No server-side enforcement.** Turning a flag off does **not** gate the AI
  endpoints — publishing is deliberately decoupled from the request path. If AI
  is unconfigured, the AI call fails on its own (a pre-existing, separate
  consequence). (**D5**)
- No database, no runtime toggling UI, no per-user/tenant targeting, no
  percentage rollouts. This is a per-environment on/off wiring switch.

## Areas where input would be most valuable

1. **Endpoint auth (Q1).** `GET /config/features` is proposed **unauthenticated**
   (like `/health`) — it reveals only "is a feature on," no data/secrets. OK, or
   require a session? (If authed, the diagnostics page's login gate becomes a
   real boundary rather than obscurity.)
2. **Route vs. `/health` (Q2).** Dedicated `GET /config/features` (recommended)
   vs. folding a `features` block into the existing `/health` payload, since
   "what's enabled" is arguably a health concern.
3. **Prefix & key naming (Q3).** `EN_FEATURE_*` prefix and
   `EN_FEATURE_REPEATED_WORD_CHECK` → `repeatedWordCheck` mapping; and comfort
   with declaring each flag var in the schema (small DRY cost, buys docs +
   validation) vs. a generic sweep.
4. **Default-derivation (Q4).** Deriving the unset default from AI-env presence —
   desirable safety, or too clever (prefer a plain `false` default)?

## Reviewer outcome

_Pending review._ Once the four questions above are answered, the confirmed
decisions (reviewer, date, PR comment links) will be recorded here and in
[`feature-flags-suggestion.md`](feature-flags-suggestion.md).
