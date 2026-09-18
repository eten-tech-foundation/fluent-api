# USFM import and source text completion

Imported USFM is stored verbatim in `project_unit_usfm_imports`. Editable
`translated_verses` need the source Bible's verse IDs, so materialization waits
until the entire source book has been ingested.

## Completion state

Migration `0030_add_bible_book_text_ingestion_completion` adds nullable
`bible_books.text_ingested_at`. A null value means completion is unknown or the
book is still incomplete. Existing `bible_texts` rows are not enough to establish
completion, and no expected chapter or verse count exists to check them against,
so the migration does not backfill them. A book left null on an existing database
is re-queued by the next project that selects it, and the idempotent ingestion
marks it complete then.

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
queued job or sees the completed source during the immediate attempt. The enqueue
runs inside the creating transaction: an import whose job could not be queued is
rolled back rather than committed as a project whose verses can never arrive.
Blank-project creation keeps tolerating a queue failure.

Completion reconciles every pending import for that Bible and book, whichever
project holds it, so an import whose own job was never queued or has given up is
not left waiting. The worker reconciles the books it completed before another
book's failure sends the job back for a retry, so a book that keeps failing
cannot strand them once the retries run out.

Materialization leaves the import pending and writes no translated verses before
source completion. After completion, matching verses are inserted with
`ON CONFLICT DO NOTHING`; real versification gaps are logged and the import is
marked materialized. Gaps do not leave an otherwise completed import pending.

Imported verse text is the words of the verse only. Footnotes, cross references,
illustration captions and study sidebars are apparatus about the verse, so they
stay in the stored file and never reach `translated_verses`.

Each imported book is attempted independently. A failed import is logged with its
import and book IDs, while other books continue. The first failure is returned
after the batch so callers retain failure visibility.

## Validation messages

`USFM_BOOK_MISSING` preserves the required "Missing book data" message from
[fluent-web #418](https://github.com/eten-tech-foundation/fluent-web/issues/418).
`USFM_BOOK_MISMATCH` identifies an invalid or mismatched book code when book data
is present. `USFM_INVALID` remains "File is not valid USFM".

## Import validation and editable projection

Before creating any project or import row, the API detects the book using the
same precedence as the upload screen: the first valid code token in `\id`,
then `\toc3`, then `\mt`/`\mt1`. Names are not translated to book codes.
The detected code must match the submitted code and exist in the book catalogue.
The grammar requires an id, so fallback files receive one only in a parsing copy.
The persisted file remains verbatim, including its original identifier and tags.

Grammar errors reject the entire batch with `USFM_INVALID`. Unsupported but
well-formed tags remain valid passthrough data; for example, custom `\z...`
markers do not produce grammar errors. Editable rows include only prose and
poetry body paragraphs. Tables, page breaks, lists, notes, figures and sidebars
remain in the original file rather than being appended to a verse's prose.
Supported headings attach to the next verse. Headings after the last verse
remain on the raw import row; attaching them before the last verse would change
source order. Import does not promise export/roundtrip support yet.

The same marker-schema validation runs during initial parsing and delayed
materialization. A heading collection over four items or a heading over 300
characters is rejected before project creation, so deterministic row-validation
failures cannot create permanently pending imports. This feature has not shipped;
there is no legacy invalid-import population to migrate. A terminal failure
column is therefore not added here. Source ingestion and transient database
failures remain retryable; a corrupted stored file still returns and logs an
explicit error rather than being marked successfully materialized.

Cross-domain reads and translated-verse writes go through their owning service
APIs, with SQL in the corresponding repositories. Import-service unit tests mock
those APIs and the projects repository, while running the actual USFM grammar.
