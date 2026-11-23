# Domain rules and review checks

These are the rules the current code and tests rely on. Each one names the code that holds it and
a test that pins it, or says that no test covers it, so a change can be checked against it. If a
change has to break a rule, say so in the PR and update this file in the same PR.

Each rule states the behavior we want. Where the code differs, the rule says so:

- **Exception:** the code differs on purpose, for the reason given.
- **Grandfathered:** the code differs and should change. Every grandfathered item is listed in
  the follow-on ticket linked from the PR that added this file.

Coding standards (the `FA-*` rules in [code-standards.md](guides/code-standards.md)) aren't
repeated here, and [permissions.md](permissions.md) stays the full reference for roles and grants.
fluent-web's [domain rules](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md)
cover the browser side of the same behaviors.

Three of these look like bugs but are intentional: when two people edit the same chapter the last
save wins (see [Saving](#saving)), `POST /bibles/:bibleId/bulk-texts` needs no session, and
`POST /ai/tts/generate` takes text without saying which Bible it comes from, so the licence check
for speech runs in fluent-web (see [Scripture text and content protection](#scripture-text-and-content-protection)).

## Permissions

fluent-api decides what a user may do. fluent-web's role checks only shape its UI, as its
[Permissions](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#permissions)
rules say. [permissions.md](permissions.md) has the roles, the permission matrix and every policy;
these bullets are the invariants a change must keep.

- `authenticate` (`src/middlewares/authenticate.ts`) runs on every request except `/api/auth/*` and
  fluent-ai's `/ai-suggestions/internal/` callbacks, and never rejects a request that carries no
  credentials. A route opts in with `authenticateUser`, which answers 401 without a user and 403
  for an inactive one ([request chain](permissions.md#request-authorization-chain)). Grants are read
  from the database on every request, so a role change applies to the next one. Tests:
  `src/middlewares/authenticate.test.ts` › "should call next() silently if no session and no Bearer
  token" and "should skip authentication for /api/auth routes";
  `src/domains/self/projects/self-projects.route.test.ts` › "returns 401 when unauthenticated" and
  "returns 403 User account is inactive and does not call the service".
- `requirePermission(X)` without a scope only asks whether the user holds X somewhere. The record's
  own scope is checked after it, by the domain's `*-auth.middleware.ts` or its policy, so a new route
  that takes a record id needs both. Tests: `src/domains/users/milestones/user-milestones.route.test.ts`
  › "returns 403 when the caller lacks project:view".
- `authorize()` (`src/lib/services/permissions/authorize.ts`) scopes every grant: a global grant
  applies everywhere, an org-wide grant to its organization and every project in it, and a grant
  pinned to a project only to that project, never to an org-level action
  ([authorize()](permissions.md#the-authorize-function)). Permissions decide, never role names, so an
  Org Manager has every Project Manager power on the projects of their organization. Tests:
  `src/lib/services/permissions/authorize.test.ts` › "org-wide PM grant applies to any project in
  that org", "project-pinned grant does NOT apply to a sibling project", "project-pinned grant does
  NOT satisfy an org-scoped action (create project)" and "grants in a different org never apply".
- Only a global SuperAdmin may write Bibles, list, create or read organizations, delete users or
  grant SuperAdmin (`requireSuperAdmin` in `src/middlewares/role-auth.ts`). Tests:
  `src/middlewares/role-auth.test.ts` › "passes a global SuperAdmin grant holder" and "rejects an
  Org Manager holding org-scoped role:assign:org_manager (#337)";
  `src/lib/services/permissions/authorize.test.ts` › "only a global SuperAdmin can assign SuperAdmin
  role".
- `activeOrgId` only narrows lists. It never grants anything, and a user can only switch to an
  organization they hold a grant in ([activeOrgId](permissions.md#activeorgid)). Tests:
  `src/domains/users/users.active-org.route.test.ts` › "returns 403 when the user does not belong to
  the requested organization".
- Editing a chapter's content (verses, audio, editor state, presence) follows
  `ChapterAssignmentPolicy.edit`, as described under [Saving](#saving), and a manager never gets a
  translator's rights. Submit moves a chapter one stage on for someone who may edit it; whoever
  submits an open Peer Check becomes its peer checker, and the drafter can never submit their own
  Peer Check. A translator (`content:update` without `content:assign`) may claim an unassigned
  chapter in Not started. Tests: `src/domains/chapter-assignments/chapter-assignments.policy.test.ts`
  › "does not let a content:assign manager use translator Peer Check rules", "allows a translator
  with content:update on an unassigned not_started chapter" and "denies a PM/org manager with
  content:assign"; `src/domains/chapter-assignments/chapter-assignments.service.test.ts` › "assigns
  peerCheckerId to the submitter when Peer Check is open" and "lets the first concurrent submitter
  win and the second keep the winner assignment".
- Assigning a drafter or a peer checker needs `content:assign` on the project, and they have to be
  two different Project Translators of the project, while the chapter's status still allows the
  change. fluent-web's
  [Permissions](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#permissions)
  rules rely on this. **Grandfathered:** no assignment path checks the role or the status.
  `PATCH /projects/:projectId/chapter-assignments/assign-selected` checks that both are
  in the project's organization and are different people
  (`src/domains/projects/chapter-assignments/project-chapter-assignments.service.ts`), while
  `PATCH /chapter-assignments/:chapterAssignmentId` and `POST /chapter-assignments` check neither.
  Resetting assignments works only from Draft or Peer Check. Tests:
  `src/domains/projects/chapter-assignments/project-chapter-assignments.reset-selected.integration.test.ts`
  › "returns 409 for complete and leaves every row unchanged". No test covers the assignment
  checks.
- Removing someone from a project, or making them an Observer, unassigns their open work: as
  drafter in Not started and Draft, and as peer checker up to Peer Check
  (`src/domains/projects/users/project-users.repository.ts`). fluent-web rewrites its cached
  assignments the same way. Tests: `src/domains/projects/users/project-users.repository.integration.test.ts`
  › "clears chapter assignments when updating to Observer role".
- Roles are granted through `canAssignRole`: SuperAdmin only by a global SuperAdmin, Org Manager
  with `role:assign:org_manager` in the organization, and the three project roles with
  `role:assign:project` on that project
  ([canAssignRole](permissions.md#role-assignment-rules-canassignrole)). Nobody changes their own
  role in an organization or a project. Tests: `src/lib/services/permissions/authorize.test.ts` ›
  "org-scoped Org Manager can assign Org Manager in their org (#337)" and "a project-pinned assign
  grant cannot assign into a different project or different org";
  `src/domains/organizations/users/org-users.service.test.ts` › "rejects a caller changing their own
  org-level role (D2)"; `src/domains/projects/users/project-users.service.test.ts` › "returns
  FORBIDDEN if the caller tries to change their own role".
- Reading, queueing and recording the use of AI suggestions needs `project:view` or
  `content:update` on the project ([AiSuggestionsPolicy](permissions.md#aisuggestionspolicy));
  queueing also needs the chapter's AI switch on (see [Async jobs](#async-jobs)). **Exception:**
  the API doesn't check the chapter's status or the caller's edit rights before queueing, since a
  suggestion never changes a verse by itself; fluent-web queues only in Draft. Tests:
  `src/domains/ai-suggestions/ai-suggestions.route.test.ts` › "requires project grants for queue,
  retrieval and exposure".
- Creating a project needs `project:create` in its organization, and the creator becomes its
  Project Manager. **Exception:** a Project Manager pinned to one project may still create projects
  in that organization, a temporary bypass described in
  [this task](tasks/2026-08-21-pm-project-create-bypass.md) (`src/domains/projects/projects.route.ts`).
  No test covers project creation's checks.
- Without a session only these answer: `GET /`, `GET /health`, the OpenAPI pages, better-auth's
  `/api/auth/*` routes, `POST /bibles/:bibleId/bulk-texts` (see
  [Scripture text and content protection](#scripture-text-and-content-protection)) and fluent-ai's
  two callbacks, which need the service key, compared in constant time
  (`src/middlewares/service-auth.ts`). Every other route needs a session, and the catalogue reads
  (`/books`, `/languages`, `/bibles`, `/pericope-sets`) need nothing more. Tests:
  `src/routes/doc.route.test.ts` › "renders the full OpenAPI spec without throwing (200, valid
  JSON)"; `src/domains/languages/languages.route.test.ts` › "returns 401 when unauthenticated". No
  test covers the service key check.

## Scripture text and content protection

- Source text lives in `bible_texts`, one row per Bible, book, chapter and verse, written only by
  ingestion and the seeds. A translation lives in `translated_verses`, one row per milestone and
  `bibleTextId`, holding plain `content` (which may be empty), optional `markers` and
  `assignedUserId`. Only three paths write verse rows: `POST /translated-verses`, turning an
  imported USFM file into verses, and moving a book to another milestone. A row with no words
  doesn't count as translated in the export, the AI look-ahead or progress. Tests:
  `src/domains/usfm/usfm.repository.integration.test.ts` › "counts only rows with words as
  translated"; `src/domains/ai-suggestions/ai-suggestions.repository.integration.test.ts` ›
  "looks ahead to a verse whose row has no words";
  `src/domains/projects/projects-usfm-milestones.integration.test.ts` › "moves an import with
  materializedAt=%s and preserves its raw file after deleting the old milestone".
- `markers` is null or an object with `headings`, `paragraphs` or both (`verseMarkersSchema` in
  `src/db/schema.ts`); `{}` is refused. Headings: 1 to 4, a `USFM_HEADING_MARKERS` marker, trimmed
  text of 1 to 300 characters with no backslash or line break (U+2028 and U+2029 included), and
  `sd` to `sd4` carry no text. Paragraphs: 1 to 20 (`MAX_VERSE_PARAGRAPHS`), offsets strictly
  increasing and inside `content`. The one repeated offset allowed is a `p` at 0 followed by
  another marker at 0, the empty `\p` before a line the verse opens (fluent-web's
  [Scripture text](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#scripture-text)
  rules depend on it). fluent-web's `HEADING_MARKERS` mirrors `USFM_HEADING_MARKERS`, so change
  both repos together. Tests: `src/db/schema.verse-markers.test.ts` › "rejects a marker that could
  smuggle USFM syntax into the export", "rejects offsets that do not strictly increase", "accepts
  an empty \p opening right before the line the verse starts" and "rejects a paragraph offset
  beyond the verse content"; `src/db/schema.verse-headings.test.ts` › "refuses heading text that
  could smuggle USFM syntax into the export", "refuses an empty heading, which would export as a
  bare marker" and "rejects newly authored text on the textless %s marker";
  `src/domains/projects/usfm-import.parse.test.ts` › "rejects %s at creation before saving an
  import". The save path has no test of its own for the 4-heading, 300-character and
  20-paragraph limits.
- On import the server decides the book from the file: the first known code in `\id`, otherwise a
  name in `\toc3` or `\mt` (`src/domains/projects/usfm-book-names.ts`). The file name never
  decides, and on the older `POST /projects` path a `bookCode` that disagrees with the file fails
  the import (`src/domains/projects/usfm-import.service.ts`). Tests:
  `src/domains/projects/usfm-import.check.test.ts` › "takes the book from \id, whatever the file is
  called (#419)" and "reads the book from \toc3 or \mt names when \id is missing";
  `src/domains/projects/projects.service.usfm-import.test.ts` › "creates the project for the books
  the files carry, not the ones the client listed".
- `POST /projects/:id/milestones/usfm-validation` writes nothing and judges each file on its own:
  no book, not valid USFM (no markers, refused by the grammar or no verses), a book already in the
  request or in `listedBookCodes`, a book the project already holds in any milestone (removed ones
  included) or a book the Source Bible lacks. `POST /projects/:id/milestones/import` runs the same
  check, creates nothing when any file is refused, and checks again inside the project lock, so a
  book added or a Source Bible changed in between answers 409
  (`src/domains/milestones/milestone-usfm-import.service.ts`). The file extension is fluent-web's
  check, not the API's. Tests: `src/domains/projects/usfm-import.check.test.ts` › "refuses a second
  file for a book already in the upload or already listed", "refuses a book the project holds,
  naming its milestone or the project" and "refuses a book the project's Source Bible does not
  have"; `src/domains/milestones/milestone-usfm-import.integration.test.ts` › "POST import creates
  nothing when a file is refused, and lists every verdict", "POST import answers 409 when the
  project gained the book after the check" and "POST import answers 409 when the Source Bible
  changed to one without the book".
- A file the grammar accepts is read as written. Only a file the grammar refuses gets one more
  try, on a copy where `\lh` and `\lf` become `\p` and an `\xt` left open in a footnote is closed.
  A parser crash gets no second try, and the stored file is never rewritten. Tests:
  `src/domains/projects/usfm-import.check.test.ts` › "reads a list the grammar accepts as written,
  so words in its header and footer stay out (fluent-web#418)", "falls back to reading list lines
  as paragraphs when the grammar refuses the list (fluent-web#418)" and "gives a parser crash no
  second try (fluent-web#418)"; `src/domains/projects/usfm-import.service.test.ts` › "materializes
  a stored fallback file without rewriting its original text".
- An imported file is kept as uploaded in `project_unit_usfm_imports`, in the same transaction
  that creates the milestone and queues the Bible text ingestion, so a queue failure rolls the
  import back. Verse rows come from it only once the Source Bible's book is fully ingested, and
  they are inserted without overwriting a row that exists, so a retry never replaces an edit.
  Verses the Source Bible lacks are skipped and logged, never invented. Footnotes, cross
  references and a heading after the last verse stay only in the stored file, and the export
  doesn't put them back. The worker retries pending imports at startup and every 60 seconds
  (`src/workers/usfm-import-recovery.ts`). Tests:
  `src/domains/milestones/milestone-usfm-import.integration.test.ts` › "POST import rolls
  everything back when ingestion cannot be queued";
  `src/domains/projects/usfm-import.service.test.ts` › "waits for confirmed book completion even
  when some source verses already exist" and "skips verses the source does not have instead of
  inventing rows"; `src/workers/usfm-import-recovery.test.ts` › "discovers imports created after
  startup and recovers a failed enqueue without restarting". No test covers the no-overwrite
  insert.
- The export (`src/domains/usfm/usfm.service.ts`, `src/lib/usfm-verse-serializer.ts`) writes each
  linked book that has source text: `\id`, `\h`, the `\toc1` to `\toc3` lines that are set and
  `\mt1`, then every source verse in order, an untranslated one as an empty `\v`. Before a verse
  come its headings and its paragraph markers at offset 0, or a default `\p` at a chapter start or
  after a heading; paragraphs inside a verse split its text at their offsets, and an offset past
  the text is dropped. Tests: `src/domains/usfm/usfm.service.test.ts` › "splits a verse across
  paragraphs at a mid-text offset", "writes an empty \p before the line a mid-chapter verse opens
  with", "ignores offsets beyond the verse content instead of corrupting the output" and "opens a
  default paragraph after a mid-chapter heading when none was stored";
  `src/lib/usfm-converter.paragraphs.test.ts` › "exports the imported paragraphs back where the
  file had them".
- Anyone who can read the project may export it (`src/domains/usfm/usfm-auth.middleware.ts`); for
  anyone else the milestone doesn't exist (404). An async export's job and download answer only
  the user who asked for it, and a download is a presigned R2 link of at most 15 minutes that never
  outlives the export's hour. Tests: `src/domains/usfm/usfm-auth.middleware.test.ts` › "lets a
  translator through only when they are a member of the project" and "denies a manager from
  another organization"; `src/lib/blob-storage.test.ts` › "caps the URL lifetime at the export
  remaining TTL near expiry". No test covers the requester check on `GET /jobs/:jobId` and
  `GET /downloads/:filename`.
- `GET /projects/:projectId/pericopes/:bookCode/:chapter` returns an empty list when the project
  has no pericope set or the set has no rows for the book, and fluent-web then shows verses one by
  one; an unknown book code is a 404. `GET /pericope-sets/:id` carries a strong ETag and answers a
  matching `If-None-Match` with 304 ([pericope-set-sync.md](guides/pericope-set-sync.md)). Tests:
  `src/domains/pericopes/pericopes.integration.test.ts` › "preserves the empty fallback for %s";
  `src/domains/pericopes/pericope-sets.integration.test.ts` › "returns an empty 304 for a matching
  %s If-None-Match" and "still returns 404 with a wildcard when the set or requested book does not
  exist".
- The API reports each Bible's `ttsLicenseStatus` from that Bible's own provider row, never from
  the recording that plays, and `unknown` when there is none. A barred Bible still serves its text
  and recordings. **Exception:** the API doesn't stop speech for a barred Bible.
  `POST /ai/tts/generate` takes only text, with no Bible or project identity (T6 in
  `src/domains/ai-tools/tts.route.ts`), so fluent-web's
  [licence fence](https://github.com/eten-tech-foundation/fluent-web/blob/main/src/features/tts/resolver/licenceFence.ts)
  is what enforces it.
  Tests: `src/domains/ai-tools/tts.route.test.ts` › "forwards the validated request to the service
  without enrichment (T6)"; `src/domains/playback-audio/playback-audio.service.test.ts` › "uses
  selected recording without borrowing its allowed text policy".
- What leaves the API: fluent-ai gets verse text and the project's id and name for the repeated
  word check, ids for AI suggestions, and text for speech. When it asks for suggestion context,
  the human translations it gets back come only from projects of the same organization
  (`src/domains/ai-suggestions/ai-suggestions.repository.ts`). BT-Servant gets the source passage,
  the prompt and the conversation with memory turned off. Aquifer, YouVersion and DBL are only
  read, their keys never reach the browser, and a key is sent only over HTTPS. fluent-web reads
  Aquifer and YouVersion through the `/aquifer` and `/youversion` proxies, as its
  [Permissions](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#permissions)
  rules say. Tests:
  `src/domains/ai-tools/ai-tools.service.test.ts` › "sends fluent-ai the resolved project id (as a
  string) and name, plus the client fields";
  `src/lib/services/aquifer/aquifer.client.test.ts` › "rejects a non-HTTPS base URL before sending
  the API key" and "redacts credentials echoed back in an upstream error body". No test covers the
  organization filter on the suggestion context.
- Logs go to Application Insights, so they never carry verse text, prompts, keys or email
  addresses. The error handler logs only the method, path and status. Tests:
  `src/server/server.test.ts` › "keeps runtime HTTP logs free of credentials and payloads for
  status %i". **Grandfathered:** some logs still carry an email address (`src/server/server.ts`,
  `src/domains/users/users.repository.ts`, `src/middlewares/authenticate.ts`), and a failed verse
  save logs the whole request, text included (`src/domains/translated-verses/translated-verses.repository.ts`).
- **Exception:** `POST /bibles/:bibleId/bulk-texts` serves source text without a session, so the
  mobile app can cache it before sign-in (decided in review on 2026-06-26). It is rate limited
  (`src/middlewares/rate-limit.ts`). Every other Bible read needs a session. Tests:
  `src/middlewares/rate-limit.test.ts` › "blocks requests over the limit with 429 and
  Retry-After". No test covers the route being open.

## Saving

- `POST /translated-verses` upserts on milestone and `bibleTextId` and replaces `content`,
  `markers` and `assignedUserId` with what the request carries
  (`src/domains/translated-verses/translated-verses.repository.ts`). A missing or null `markers`
  clears the stored structure, which is why every fluent-web save path decides which markers to
  send. `content` is stored as sent, with no trimming. No test covers the upsert itself.
- A save records the caller as the verse's `assignedUserId`. **Grandfathered:** a body that names
  another user is stored as sent (`src/domains/translated-verses/translated-verses.route.ts`).
- Who may save a verse depends on its chapter's assignment
  (`src/domains/translated-verses/translated-verse-auth.middleware.ts`, `ChapterAssignmentPolicy.edit`
  in `src/domains/chapter-assignments/chapter-assignments.policy.ts`), looked up from the verse's
  own Bible, book and chapter: in Draft only the drafter; in Peer Check the assigned peer checker,
  or any other member who isn't the drafter while none is assigned; in the stages after peer check
  and before Complete any project member, managers included, which fluent-web's
  [Permissions](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#permissions)
  rules rely on. In Not started and Complete nobody may save, and a denial is a 404. So unlike
  fluent-web, the API does lock verses by status, and a verse of a neighbouring chapter is judged
  by that chapter's assignment. Tests:
  `src/domains/chapter-assignments/chapter-assignments.policy.test.ts` › "denies the drafter on
  open Peer Check", "allows a project member with content:update who is not the drafter", "keeps
  PM exclusivity when peerCheckerId is already set" and "denies edit in custom stage when stages
  are absent or stage is unlisted"; `src/domains/chapter-assignments/chapter-assignments.repository.test.ts`
  › "requires the assignment Bible to match the verse Bible". No test covers Draft being the
  drafter's alone or the lock in Not started and Complete.
- Verse saves carry no version, so when two people edit the same chapter the last save wins, on
  purpose, as fluent-web's Saving rules describe. `POST /chapter-assignments/:id/presence` only
  tells the client whether someone else has the chapter open; the save path never reads it
  (`src/domains/chapter-assignments/presence/`). No test covers this.
- `GET /translated-verses` returns the stored `markers`. **Grandfathered:** markers that no longer
  pass `verseMarkersSchema`, such as an old `sd` heading with text, come back as `null`
  (`src/domains/translated-verses/translated-verses.service.ts`), and a client that saves what it
  read then wipes them. No test covers the read.
- A save that crosses the AI suggestion threshold sends the backfill only after the transaction
  commits, and a failed backfill never loses the save. Tests:
  `src/domains/translated-verses/translated-verses.service.test.ts` › "sends the backfill only
  after the transaction has committed" and "keeps the draft saved when the backfill throws".
- Only verse audio carries a version token (`verse_audio_recordings.version_token`); editor
  state, `/self/settings`, book metadata and verses all keep the last write. Version-token writes
  follow `.claude/skills/versioned-resource-writers/SKILL.md`. A verse audio upload with the
  current `baseVersionToken` replaces the active take, a stale one keeps both takes and marks a
  conflict, and none at all is an older client that gets last write wins. Only
  `POST /verse-audio/:projectUnitId/:bibleTextId/resolve` clears a conflict, as a compare and
  swap. Tests: `src/domains/verse-audio/verse-audio.concurrency.service.test.ts` › "marks conflict
  when baseVersionToken is stale" and "does not let a losing client clear its own conflict by
  retrying the same bytes"; `src/domains/verse-audio/verse-audio.upload.service.test.ts` ›
  "replaces cleanly when baseVersionToken is omitted (legacy clients)";
  `src/domains/verse-audio/verse-audio.service.test.ts` › "rejects resolve when the unit is clean
  (never conflicted)".
- A take is deleted by its uploader or someone with `content:assign`; other readers get 403
  ([permissions.md](permissions.md#verse-audio-take-delete)). Deleting the active take promotes the
  newest one left. Tests: `src/domains/verse-audio/verse-audio.delete-take.service.test.ts` ›
  "returns FORBIDDEN for a non-owner without content:assign";
  `src/domains/verse-audio/verse-audio.delete-take.integration.test.ts` › "promotes the newest
  remaining take when the active take is deleted".
- `PUT /chapter-assignments/:id/editor-state` replaces the whole saved state of one user in one
  chapter, with no version (`src/domains/chapter-assignments/editor-state/`). Two tabs of the same
  user overwrite each other. No test covers the replace.
- `PUT /self/settings` merges by top-level key in one SQL upsert: a key that isn't sent stays, a
  key that is sent replaces its whole value, and `displayMode: null` removes that key
  (`src/domains/self/settings/`). fluent-web's rules still call this a full replace. Tests:
  `src/domains/self/settings/self-settings.route.test.ts` › "merges displayMode without erasing
  suppressions (legacy web-style write preserves displayMode)" and "same-key last server-saved
  write wins (no clock/ETag)";
  `src/domains/self/settings/self-settings.repository.integration.test.ts` › "retains both keys
  when overlapping different-key patches hit ON CONFLICT on first insert (single-connection
  scheduling)".
- `PATCH /project-units/:projectUnitId/book-details/:bookId` writes only the fields it names. A
  null or blank value clears a field, values are trimmed and refused when they hold a backslash,
  `|` or a line break, and the export leaves out a `\toc` line whose field is empty. Tests:
  `src/domains/book-details/book-details.types.test.ts` › "clears a field on empty string or null",
  "rejects values that could smuggle USFM syntax into the export, in every field" and "leaves an
  absent field absent, so the update does not touch it".
- Deleting a milestone deletes its verses, stored imports, assignments and recordings through
  foreign key cascades; the audio files are reclaimed later. A project with milestones can't be
  deleted (409). Tests: `src/domains/projects/projects-usfm-milestones.integration.test.ts` ›
  "keeps the normal DELETE guard for a project with milestones". No test covers the cascade.

## Async jobs

Workers run in `src/workers/standalone-worker.ts`, a process of its own (see the
[code map](code-map.md#workers)). [ai-suggestions-workflow.md](ai-suggestions-workflow.md)
describes the AI suggestion flow, but parts of it are out of date: the code queues by pericope,
each job is one verse, and the worker sends five jobs at a time.

- The API listens before it touches anything it depends on
  ([ADR 0001](adr/0001-listen-before-initializing-external-dependencies.md)): `serve()` runs
  first, the queue setup retries every 5 seconds until it works, and `GET /health` always answers
  200 (`src/index.ts`). A route that needs the queue answers 503 until `isQueueReady()` is true.
  **Grandfathered:** only the async export routes do (`src/domains/usfm/usfm.route.ts`); the AI
  queue endpoints answer 500. No test covers the startup order.
- Shutdown runs once: it stops the timers, stops taking connections while Assistant streams
  finish, stops the queue and exits. Tests: `src/index.signals.test.ts` › "drains and exits only
  once when both shutdown signals arrive repeatedly"; `src/index.shutdown.test.ts` › "stops
  listener admission before settling active Assistant responses" and "force-closes connections and
  finishes when normal drain exceeds its bound".
- The worker fails fast instead of half running: it exits unless the R2 credentials are set and the
  exports bucket answers, so without R2 the AI trigger and the Bible text ingestion stop too. Every
  app instance runs a worker, and pg-boss hands each job to one of them. No test covers
  `src/workers/standalone-worker.ts`.
- Each queue in `QUEUE_NAMES` (`src/lib/queue.ts`) dead-letters into `<name>-dlq`. `usfm-export`,
  `ai-suggestions` and `usfm-import-materialize` are exclusive, with fixed retries and expiry; the
  two DBL ingest queues use pg-boss's defaults. Setting up a queue never deletes one, never
  shortens retention and never changes a policy: a mismatch is logged and fixed offline with
  `npm run queue:migrate-policy` (see the [dead-letter runbook](runbooks/worker-dead-letter-queues.md)).
  Tests: `src/lib/dead-letter-queues.test.ts` › "adds a DLQ to the current AI queue and keeps its
  retry contract", "creates the DLQ first and converges routing on an existing source queue" and
  "preserves longer retention and never updates immutable source policy".
- Dead-letter queues are watched, never consumed. The API counts every one when the queue is ready
  and every 60 seconds after, zero included
  ([queue-monitoring-alerts.md](runbooks/queue-monitoring-alerts.md)). Tests:
  `src/lib/dead-letter-queues.test.ts` › "emits metric with value 0 for zero-depth queues rather
  than silence" and "sweeps immediately, avoids overlap, waits for shutdown and stops its timer".
- On an exclusive queue, a job whose singleton key matches a waiting or active job isn't created,
  and the caller treats that as a duplicate: the same export from the same user answers 409, an AI
  verse or title already queued counts as queued, and a materialization already queued is
  accepted. Tests: `src/domains/ai-suggestions/ai-suggestions.service.test.ts` › "sends one job
  per verse, deduplicated per verse"; `src/workers/ingest-bible-text.worker.test.ts` › "accepts a
  duplicate materialisation retry that is already queued". No test covers the export's 409.
- Code that reads pg-boss's tables directly checks that the schema is version 26 and does nothing
  on any other (`src/lib/pg-boss-schema.ts`). **Grandfathered:** the heartbeat's count of pending
  jobs (`src/workers/queue-heartbeat.ts`) doesn't check. Tests:
  `src/lib/dead-letter-queues.test.ts` › "reports an explicit error and skips job queries for an
  unsupported schema"; `src/workers/usfm-import-recovery.test.ts` › "does not inspect or enqueue
  against an unsupported pg-boss schema".
- Bible text ingestion can safely run again: verses upsert, a book counts as ingested only once all
  its chapters landed, and a failed chapter fails the whole job so it retries
  (`src/workers/ingest-bible-text.worker.ts`). Tests:
  `src/workers/ingest-bible-text.worker.test.ts` › "marks a failed chapter-list fetch as a job
  failure so pg-boss retries, instead of silently dropping the whole book", "does not mark a source
  book complete with %s" and "materialises a completed book before another book failure sends the
  job back for a retry".
- A pending USFM import stays pending until it becomes verses, and the recovery sweep keeps
  sending it unless a job for it is waiting or it sits in the dead-letter queue
  (`src/workers/usfm-import-recovery.ts`). Tests: `src/workers/usfm-import-recovery.test.ts` ›
  "leaves a dead-lettered book pending across sweeps and worker restarts while recovering other
  books" and "stops resubmitting when a previously queued job reaches the dead-letter queue".
- A request that queues work fails when its job can't be queued, so nothing is left half done: a
  milestone import queues its jobs inside the request's transaction, and creating a project from
  USFM rolls back. **Grandfathered:** a blank project, Add Milestone and moving a book log the
  failure and succeed, and nothing sends the ingestion again, so those books stay without text or
  chapter assignments (`src/domains/projects/projects.service.ts`,
  `src/domains/milestones/milestones.service.ts`). Tests:
  `src/domains/projects/projects.service.usfm-import.test.ts` › "fails the creation when the
  ingestion job cannot be queued, instead of leaving the import stranded" and "still creates a
  blank project when the ingestion job cannot be queued".
- An export job either stores its ZIP or throws, so pg-boss retries it and then dead-letters it,
  and the ZIP lives one hour. Tests: `src/workers/usfm-export.worker.test.ts` › "registers with
  batchSize 1 so per-job failures reach pg-boss" and "rejects when the blob upload fails, and still
  runs cleanup".
- AI suggestions are queued only while the project family (same source language, target language
  and organization) has at least `AI_ACTIVATION_THRESHOLD_VERSES` drafted verses and the chapter's
  AI switch is on. `queue-next` queues the pericope the translator is in and the next one, never
  past the chapter; `queue-pericopes` queues the named pericopes' empty verses and an eligible
  title. Verses that already have a draft or a suggestion are skipped. Tests:
  `src/domains/ai-suggestions/ai-suggestions.service.test.ts` › "queues the pericope the translator
  is in and the one after it", "does not cross the chapter boundary from the last pericope", "leaves
  out verses that already have a draft or a suggestion", "reports the threshold and queues nothing
  below it" and "queues nothing while the AI toggle is off for the chapter".
- Only the save that takes a family over the threshold queues the backfill, under an advisory lock
  (`claimActivationCrossing`). Tests:
  `src/domains/ai-suggestions/ai-suggestions.activation.service.test.ts` › "claims the crossing for
  the save that takes the family over the threshold" and "does not claim it for the save that lost
  the race, which finds the family already over".
- The AI trigger worker sends up to five jobs at once to fluent-ai's `suggestions`. Any failure
  fails the whole batch, and each job retries three times before it is dead-lettered. Results come
  back through `POST /ai-suggestions/internal/results` and replace the stored suggestion; the API
  keeps no job status, and clients poll `GET /ai-suggestions` and `GET /ai-suggestions/pericopes`.
  A title is stored only while it is still eligible. Tests:
  `src/lib/services/fluent-ai/fluent-ai.client.test.ts` › "throws an error when HTTP response is
  not ok"; `src/domains/ai-suggestions/ai-pericope.service.test.ts` › "completes stale range/set
  jobs as a no-op" and "does not cache a result when title eligibility is %s". No test covers the
  service key check on the internal routes.
- The repeated word check is a synchronous call with no queue. The API resolves
  `project_unit_id` to its project, checks the caller can read that project, and fills fluent-ai's
  `project_id` and `project_name` itself (fluent-api#420). Tests:
  `src/domains/ai-tools/ai-tools.route.test.ts` › "authorizes against the project that owns the
  unit, not the raw project_unit_id" and "returns 404 when the caller is not a member of the
  resolved project".
- Catalogue cursors never skip a committed write. Every write to languages, books and Bibles stamps
  `updated_at` from `next_catalogue_watermark()`, which keeps the stamps in commit order, so a
  client that syncs with `updatedAfter` doesn't miss rows
  ([catalogue-watermark.md](guides/catalogue-watermark.md)). An unchanged upsert keeps its stamp.
  Tests: `src/domains/catalogue-sync.watermark.allocator.integration.test.ts` › "pins DEFAULT,
  $onUpdate, and upsert conflict arms past the wall clock" and "books upsert does not stamp
  updatedAt on unchanged re-sync but still links"; `src/lib/updated-after-query.test.ts` › "rejects
  date-times without an explicit time zone".

## Feature flags and env

- Flags only tell clients what to show. `GET /config/features` (`src/routes/config.route.ts`)
  needs a session and always returns the four flags in `FLAGS` (`src/lib/features.ts`). Nothing
  else reads them, so a request is never refused because a flag is off, and each feature keeps its
  own permission checks (see the [feature flags proposal](features/feature-flags/feature-flags-suggestion.md)).
  If a flag ever has to gate the API, the check goes in the service. Tests:
  `src/routes/config.route.test.ts` › "returns 401 when the caller is not authenticated (no
  session)"; `src/lib/features.test.ts` › "returns exactly the known flag keys — no extras, none
  missing". No test pins that nothing else reads them.
- Each flag is one `EN_FEATURE_*` variable, read once at boot. `true`/`false`, `1`/`0`,
  `yes`/`no` and `on`/`off` are accepted, blank means unset, and anything else stops the process.
  Unset, `repeatedWordCheck` and `aiSuggestions` are on when fluent-ai is configured, and
  `sourceAudio` and `assistant` are off. Since `FLUENT_AI_URL` and `FLUENT_AI_KEY` are required,
  the first two are on wherever the API runs. Tests: `src/lib/features.test.ts` › "derives
  repeatedWordCheck = true when unset and AI is wired" and "keeps assistant = false when unset
  regardless of service wiring"; `src/env.test.ts` › "parses %s as %s".
- A new flag goes in `src/env.ts` (`EN_FEATURE_<NAME>`), in `FLAGS` and in the route's
  `featuresSchema`, then in `.env.example` and in fluent-web's `FeatureName` and
  `failClosedFeatures`. fluent-web reads flags fail closed from `GET /config/features`, as its
  [Feature flags](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/domain-rules.md#feature-flags)
  rules say. Tests: `src/lib/features.test.ts` › "env schema flags (camelCased) match
  the FLAGS registry keys", "registry keys (FLAGS) match the OpenAPI featuresSchema keys" and
  "every FLAGS entry points at a declared EN_FEATURE_* env var".
- `src/env.ts` validates the environment once, on import, and exits on any error, in the API, the
  worker and the scripts alike. Optional integrations degrade instead of blocking boot: without R2
  the async export and verse audio answer 503 and the worker won't start, without an Aquifer or
  YouVersion key their proxies answer 502, and a bad Assistant setting only turns the Assistant
  off. Tests: `src/env.test.ts` › "keeps blank and malformed values raw so they cannot fail global
  API boot" and "parses fine when R2 is not configured at all".
- `NODE_ENV=production` turns on Application Insights, makes the auth cookies cross-subdomain on
  `BETTER_AUTH_COOKIE_DOMAIN` and trusts `https://*.fluent.bible` (`src/lib/auth.ts`,
  `src/lib/logger.ts`). Tests: `src/lib/logger.test.ts` › "turns off only the pg instrumentation
  before starting". No test covers CORS or the trusted origins.
- Nothing migrates the database or creates a schema at boot. pg-boss runs with
  `createSchema: false`, `src/db/scripts/bootstrap.ts` and `src/db/scripts/provision-db.ts` create
  the schemas and roles, and migrations run with `npm run db:migrate`
  ([db-provisioning-and-setup.md](db-provisioning-and-setup.md)). No test covers this.
