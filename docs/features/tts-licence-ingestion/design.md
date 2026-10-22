# TTS licence ingestion — design

> Status: agreed 2026-10-20 (Kasey Wright, Chad White, Joel Mathew). Target: Phase 1 before the E10 Summit.
> Glossary terms: **TTS licence status**, **Unknown**, **Licence notice**, **All rights reserved**, **Licence fence** — see [`CONTEXT.md`](../../../CONTEXT.md).
> Decision record: [ADR 0003](../../adr/0003-tts-licence-status-derived-from-licence-text.md).

## Problem

Source TTS is built and works on dev/QA, but the licence fence in fluent-web only
synthesizes speech for Bibles whose TTS licence status is `allowed`. The DBL sync
never writes `bible_provider_resources` rows, so every DBL Bible resolves to
`unknown` and TTS is effectively off everywhere except three seeded/forced
Bibles. We need licence facts ingested **ahead of time**, automatically, without
a support person approving Bibles one at a time — translators shouldn't press
play and wait on a licence check.

## Constraints from the meeting

- **Scope is Bibles only.** Aquifer resources are all open licence; not affected.
- **How TTS is used:** generated on demand in-app, cached on our side (R2), never
  downloadable by the end user, and only a passage at a time — never the whole
  Bible in one go. The licence rules below are judged against that usage.
- **DBL is the authority** for source Bibles. Everything our DBL key can see is
  open licensed — that's why we have access — which justifies Phase 1's
  optimistic default.
- **All rights reserved is a hard deny.** This is the most important rule.
- **Interim, not final.** No lawyer review now (premature; rabbit hole). The AI
  pass is "poor man's due diligence"; E10 represents UBS/ABS and the major Bible
  societies, and a publisher who objects can ask us to switch it off.
- **Classify before the user asks, not when they press play.** Classification
  runs in the ingestion path, not when TTS is requested.

## What already exists

| Piece                                                                                                                        | Where                                                    | State                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bible_provider_resources` (provider, external_id, `tts_license_status` default `unknown`, `license_notice`, `display_name`) | `src/db/schema.ts`                                       | Exists. Only seeds write it.                                                                                                   |
| Watermark trigger: status/notice changes bump `bibles.updated_at`                                                            | migration `0037`                                         | Exists. Web picks changes up via `GET /bibles?updatedAfter=`.                                                                  |
| `ttsLicenseStatus` on Bible / assignment / playback responses                                                                | `bibles.service.ts`, `playback-audio.service.ts`         | Exists; absent row → `unknown`.                                                                                                |
| DBL `copyright` / `info`                                                                                                     | `dbl.types.ts` `dblBibleSchema`                          | Only on single-Bible fetch or `include-full-details`. `getBibles()` parses with `dblBibleSummarySchema`, which **drops** them. |
| Licence fence                                                                                                                | fluent-web `features/tts/resolver/licenceFence.ts`       | Exists. Bars synthesis unless `allowed`; recorded audio still plays.                                                           |
| "Hide audio controls" setting                                                                                                | fluent-web `features/tts/settings/HideAudioSettings.tsx` | Exists, in the global Settings modal; no licence message.                                                                      |

## Decisions

1. **The licence is DBL's `copyright` string.** DBL has no structured licence
   field. `info` is promo text and isn't classified.
2. **Text Bibles only.** One resource row per DBL text Bible
   (`provider='dbl'`, `external_id = bible.id`). Recording (`audioBibles`) rows
   and `bibles.audio_resource_id` are out of scope.
3. **Phase 1 — optimistic:** new rows are `allowed`; `license_notice` = raw
   `copyright`. On conflict the sync refreshes `license_notice` and
   `display_name` but **never** `tts_license_status`, so re-runs don't duplicate
   anything and existing decisions (including the seeded/forced rows) survive.
4. **Phase 1 closing step — all-rights-reserved sweep:** a single
   `UPDATE … SET tts_license_status='forbidden' WHERE provider='dbl' AND
license_notice ILIKE '%all rights reserved%'`. English pattern only; the
   step logs the distinct notices it did _not_ match. Non-English phrasings are
   left to Phase 2.
5. **"Unique licenses" in Phase 1** = `SELECT license_notice, count(*) … GROUP
BY license_notice` after the sync; the script logs the distinct count.
6. **Phase 2 — classified, deny-by-default:** new table
   `licence_classifications`, keyed by **normalized** notice text (lowercase,
   whitespace collapsed, `©`/`(c)`/`copyright` and 4-digit years stripped),
   holding status, rationale, `classified_by`, `reviewed_at`.
7. **Phase 2 status is derived on every sync** (supersedes 3's insert-only rule):
   empty notice → `forbidden`; classification match → its status; no match →
   insert the normalized text as `unknown` (= flagged for review) and the Bible
   is `unknown`. No per-Bible override — reclassify the text instead (ADR 0003).
8. **Classification rules, in order:**
   1. All rights reserved (any language) or empty → `forbidden`.
   2. Any Creative Commons licence (incl. NC/ND variants) or public domain → `allowed`.
   3. Otherwise an AI pass across 2–3 models judged against our usage (above):
      any model finds an explicit prohibition → `forbidden`; models disagree →
      `unknown` for a human; otherwise → `allowed`.
9. **The AI pass is an offline, one-off developer script.** Its output (text →
   status + per-model rationale) is reviewed by a human and committed as data
   that loads `licence_classifications`. It never runs inside the sync or at
   request time.
10. **"Flagged for review" is `unknown`.** No new enum value. Backlog query:
    `SELECT * FROM licence_classifications WHERE status = 'unknown'`.
11. **fluent-web blocks synthesis only.** Recorded audio on a blocked Bible keeps
    playing (the fence already does this). The "Hide audio controls" toggle
    stays enabled. When the current source Bible isn't `allowed`, a message
    appears under it: text-to-speech isn't available for _{Bible}_ because of
    its licensing terms. Product owns the final wording.

12. **Data model clean-up (API-5, ADR 0004).** Provider facts live only on the provider resource; a Bible holds Fluent records plus two FKs, `text_resource_id` and `audio_resource_id`. `bibles.provider`, `external_id` and `has_audio` move to (or are replaced by) the resource, `bible_provider` folds into `resource_provider`, and there is no `kind` column. The table keeps its name.

## Follow-ups (tracked, not ticketed here)

- **Server-side enforcement.** `POST /ai/tts/generate` is Bible-blind; the fence
  is a client-side UX control, not a legal one. Closing that means sending the
  text Bible key and rejecting non-`allowed` — a TTS API contract and cache-key
  change. Worth doing given "hard deny is most important," but it doesn't block
  the summit.
- **Public takedown notice.** Joel: say on the website/terms that publishers who
  object to how we use their text can contact us and we'll switch it off.
  Product/legal, not engineering.
- **YouVersion secondary Bibles** (Chad). A YouVersion resource with no row is
  `unknown`, which blocks it — safe by default. Needs its own investigation.
- **Human oversight / privacy policy.** Joel expects longer-term human review of
  these decisions; the `reviewed_at` column and the `unknown` backlog are the
  hook for it.
- **Ingestion architecture.** This is a first instance of the broader question
  of pre-processing ingested (and eventually team-produced) source content so
  users never wait. Out of scope.
