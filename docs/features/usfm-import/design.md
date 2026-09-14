# USFM import and source text completion

Imported USFM is stored verbatim in `project_unit_usfm_imports`. Editable
`translated_verses` need the source Bible's verse IDs, so materialization waits
until the entire source book has been ingested.

## Completion state

Migration `0029_add_bible_book_text_ingestion_completion` adds nullable
`bible_books.text_ingested_at`. A null value means completion is unknown or the
book is still incomplete. Existing `bible_texts` rows are not enough to establish
completion, and the migration does not backfill them.

The ingestion worker sets the timestamp only after it has fetched and written
every numbered chapter of that book. Failed chapter requests, invalid chapter
numbers, empty chapter text and an empty numbered-chapter list leave completion
unset and cause the job to retry. A completed book stays complete during later
idempotent ingestion because the worker only upserts source verses.

The IRV seed marks its known complete corpus in the same transaction as its verse
inserts. Its idempotent rerun also marks completion after checking the full
expected corpus count, allowing previously seeded local databases to use imports.

## Project creation and materialization

For USFM projects, creation queues selected books whose completion timestamp is
null, even if some source verses already exist. This also gives each importing
project its own completion hook when another project is ingesting the same Bible.
The blank-project queue policy is unchanged.

Creation decides whether to enqueue before attempting immediate materialization.
If another worker finishes concurrently, the import therefore either has its own
queued job or sees the completed source during the immediate attempt.

Materialization leaves the import pending and writes no translated verses before
source completion. After completion, matching verses are inserted with
`ON CONFLICT DO NOTHING`; real versification gaps are logged and the import is
marked materialized. Gaps do not leave an otherwise completed import pending.

Each imported book is attempted independently. A failed import is logged with its
import and book IDs, while other books continue. The first failure is returned
after the batch so callers retain failure visibility.

## Validation messages

`USFM_BOOK_MISSING` preserves the required "Missing book data" message from
[fluent-web #418](https://github.com/eten-tech-foundation/fluent-web/issues/418).
`USFM_BOOK_MISMATCH` identifies an invalid or mismatched book code when book data
is present. `USFM_INVALID` remains "File is not valid USFM".
