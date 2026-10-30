# USFM import and source text completion

Imported USFM is stored verbatim in `project_unit_usfm_imports`, added by migration
`0030_add_usfm_imports`. Editable
`translated_verses` need the source Bible's verse IDs, so materialization waits
until the entire source book has been ingested.

## Completion state

Migration `0031_add_bible_book_text_ingestion_completion` adds nullable
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

The milestones API creates a project without an initial unit when the request
supplies `sourceBibleId` alone. Import requests also supply `usfmFiles` and create
the initial unit for those files. Existing clients may still supply `bibleId`
and `bookId` to create that unit in one request; both paths save `sourceBibleId`
on the project. Supplying different values for the two Bible IDs is rejected.
Milestone creation and editing endpoints keep their current behavior.

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

If immediate materialization fails after creation commits, each imported book
gets an independent `usfm-import-materialize` job, deduplicated by Bible and book.
An enqueue failure is logged without preventing the other books from being queued.
The pending import row is the durable retry intent. After registering its queues,
the worker discovers pending imports immediately and every 60 seconds, joining
the current active unit/book link to a source book with explicit completion. It
queues each distinct Bible/book pair with the same singleton key. Query or send
failures leave the rows pending for the next sweep, so a queue outage can recover
without restarting the worker. Sweeps do not overlap, do not change completion
timestamps, and stop before queue shutdown. Moved books are discovered at their
current milestone; deleted links are skipped until restored.
This also retries completed source books, which have no ingestion job to revisit
them. The worker heartbeat reads the import queue's pending rows directly so a
drained queue reports zero and delayed jobs are counted only once.

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

## Add Milestone import

[fluent-web #418-#420](https://github.com/eten-tech-foundation/fluent-web/issues/418)
move the import from Create Project to the Add Milestone dialog of an existing
project. Two routes serve it, both behind the Add Milestone gate (`project:update`
plus update access to the project):

- `POST /projects/{projectId}/milestones/usfm-validation` checks files as the
  dialog adds them and writes nothing. Each file gets a verdict: its book, or
  `USFM_INVALID`, `USFM_BOOK_MISSING`, `USFM_BOOK_DUPLICATE` (another file in the
  upload or one of `listedBookCodes`, the books the dialog has accepted),
  `USFM_BOOK_EXISTS` or `USFM_BOOK_NOT_IN_SOURCE`.
- `POST /projects/{projectId}/milestones/import` takes `{ name, files }` and
  creates one milestone. It runs the same check first; if any file is refused,
  nothing is created and the 400 lists every verdict.

An import never merges into content the project already has, so a book in any
milestone of the project is refused, including a book that was removed from its
milestone and only sits in the project (`milestoneName: null`). Add Milestone's
own create path moves such a book into the new milestone instead; the import
does not. The project's books are read again inside the project lock, and a book
added after the check answers 409 with nothing created.

A book the project's Source Bible lacks is refused at upload, because its verses
could never be attached. The milestone takes everything else from the project:
languages, Source Bible, the connectivity default and the pericope set.

Inside one transaction the import creates the milestone, links its books,
creates chapter assignments for books with source text, stores every file
verbatim in `project_unit_usfm_imports` and queues priority ingestion
(`DBL_INGEST_TEXT_PRIORITY`, one job per book) for books whose source text is not
complete. A queue failure rolls the whole import back, since such an import could
never finish. After the commit, books with complete source text are materialized
at once; a materialization failure only queues `USFM_IMPORT_MATERIALIZE` retries.

Until the web stops sending them, `POST /projects` still accepts `usfmFiles` for
the old Create Project flow. Removing that path is a follow-up once the Add
Milestone import ships.

## Import validation and editable projection

Before creating any project or import row, the API detects the book using the
same precedence as the upload screen: the first valid code token in `\id`,
then `\toc3`, then each `\mt`/`\mt1`/`\mt2` line. `\toc3` and `\mt` usually
hold a name rather than a code, so after the code check `usfm-book-names.ts`
maps English names and SBL-style abbreviations ("Obad", "1 Chr", "First
Chronicles") and the Hindi IRV names (eBible `hin2017`, Door43 `hi_irv`) to
codes, ignoring case, spacing, periods, ordinals and title filler. The file name
never decides the book.
The detected code must match the submitted code and exist in the book catalogue.
The grammar requires an id, so fallback files receive one only in a parsing copy.
The persisted file remains verbatim, including its original identifier and tags.

Grammar errors reject the entire batch with `USFM_INVALID`. Unsupported but
well-formed tags remain valid passthrough data; for example, custom `\z...`
markers do not produce grammar errors. Editable rows include prose and poetry body paragraphs, plus verses that start
inside list or other non-heading paragraphs. Text before the first verse milestone
in those paragraphs, and paragraphs with no milestone, stay in the original file;
the import logs a warning with the chapters and the character count when body
paragraph text is left out this way.
Tables, notes, figures and sidebars remain in the original file rather than being
appended to a verse's prose.
Supported headings attach to the next verse. Headings after the last verse
remain on the raw import row; attaching them before the last verse would change
source order.

Each row also stores its body paragraphs in `markers.paragraphs`, in the same
`{ marker, offset }` form the web editor saves: offset 0 when the verse number
opens the paragraph, and the offset in the saved text when a paragraph starts
inside the verse. An empty `\p` right before a line that starts with a verse
number, as in `\p` then `\q1 \v 3` (a paragraph that starts with a poetry line),
is kept as a `p` at offset 0 ahead of the line's own marker. A `\p` with words in
it is not empty, even when the words come before the chapter's first verse and
stay out of the rows. Any other paragraph with no words has nothing to anchor it
and is dropped.
A row holds at most `MAX_VERSE_PARAGRAPHS` (20); the import
keeps the first 20 and logs a warning. A verse with no words that carries a
heading or opens a paragraph is stored as a row with empty content, so the
structure survives. AI look-ahead, chapter progress and the export book list
count only rows with words as translated.

Export rebuilds headings and body paragraphs from the rows, so those round-trip.
Other markers (`\ip`, `\tr`, `\pb`, `\esb`, notes, figures, `\z*`) are not in
the rows and export does not merge the raw file back, so the round trip is not
lossless yet. That follow-up is tracked in
[fluent-web #397](https://github.com/eten-tech-foundation/fluent-web/issues/397).

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
