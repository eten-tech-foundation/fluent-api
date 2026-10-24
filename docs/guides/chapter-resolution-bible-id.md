# Chapter resolution and `bible_id` (#295)

Three paths answer "which chapter is this?" They must agree that
**`bible_id` is part of the chapter key** — unit + book + chapter alone is
not enough.

| Path                       | Location                                        | How it scopes by bible                                                                     |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Verse → assignment         | `chapter-assignments.repository` `findForVerse` | `chapter_assignments.bibleId = bible_texts.bibleId`                                        |
| Chapter audio list         | `verse-audio.repository` `listByChapter`        | `bible_texts.bibleId =` caller `bibleId`                                                   |
| Progress / conflict rollup | `chapter-assignments-progress.repository`       | `bible_texts` join and `hasConflictRollupSql` both filter on `chapter_assignments.bibleId` |

## Why

A unit whose `chapter_assignments.bible_id` differs from the bible behind its
`bible_texts` rows must not authorize via book/chapter match while dropping
out of the rollup (or the reverse). Same underlying row, two answers, is the
bug #295 filed.

The assignment-to-link leg is DB-enforced: `chapter_assignments` has a
composite FK to `project_unit_bible_books (project_unit_id, book_id, bible_id)`
with `ON UPDATE CASCADE` / `ON DELETE CASCADE` (migration
`chapter_assignment_bible_fk`). An assignment cannot exist without a matching
book↔bible link for its unit. That does not cover verse-level pointers
(`verse_audio_recordings.bibleTextId`, `translated_verses.bibleTextId`) or
soft-deleted links (`deletedAt` is invisible to FKs) — those still rely on
the three query paths filtering by bible.

## Behaviour when they disagree

`findForVerse` returns `CHAPTER_ASSIGNMENT_NOT_FOUND` — same as a missing
assignment. Do not silently match on book/chapter. Callers that need a
stronger signal for the divergent state should add an explicit check; do not
weaken the predicate.

## Do not

- Drop the `bibleId` / `bible_id` predicate from any of the three paths.
- "Fix" a missing chapter by matching book/chapter across bibles.
- Treat the rollup join's `bible_id` as optional "extra safety" — it is the
  same key as authorization and listing.
