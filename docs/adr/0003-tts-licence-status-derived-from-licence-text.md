# TTS licence status is derived from licence text, and unknown text means deny

A Bible's TTS licence status is never set on the Bible directly. It is derived
on every DBL sync from a classification of that Bible's **licence notice**
(DBL's free-text `copyright`), held in one row per normalized notice. Text with
no classification becomes `unknown`, which bars synthesis exactly like
`forbidden` — deny-by-default — and is the review backlog. An empty notice is
`forbidden` (treated as all rights reserved).

We chose this over a per-Bible flag because DBL has no structured licence field
and hundreds of Bibles share a handful of licence texts: one decision per text
is reviewable, auditable (the AI pass's rationale is stored with it), and
re-evaluates automatically when a publisher changes a Bible's notice.

**Consequences:** there is no per-Bible override. To change one Bible's status,
reclassify its licence text; if a genuine one-Bible exception is ever needed,
it is a new decision, not a manual `UPDATE` on `bible_provider_resources` —
the next sync would overwrite it. The interim Phase 1 state (every DBL Bible
`allowed`, status written on insert only, plus an all-rights-reserved sweep)
is superseded by this once Phase 2 ships.
