# Code map

Where things live in `src/` and what each part calls. How a domain module is built (route,
service, repository, policy) is in [ARCHITECTURE.md](../ARCHITECTURE.md), the rules the code
relies on are in [domain-rules.md](domain-rules.md), and setup is in
[CONTRIBUTING.md](../CONTRIBUTING.md).

## Outside this repo

- [fluent-web](https://github.com/eten-tech-foundation/fluent-web) is the only browser client.
  It signs in through better-auth (`src/lib/auth.ts`) and sends the session cookie with every
  call. CORS (`src/server/server.ts`) and better-auth's trusted origins allow `FRONTEND_URL` and,
  in production, any `*.fluent.bible` origin. Mobile clients send a bearer token instead. The
  routes below say which fluent-web feature calls them, using the same endpoint strings as
  fluent-web's [code map](https://github.com/eten-tech-foundation/fluent-web/blob/main/docs/code-map.md),
  so a search finds both sides.
- [fluent-ai](https://github.com/eten-tech-foundation/fluent-ai) gets calls from
  `src/lib/services/fluent-ai/fluent-ai.client.ts` with an `X-API-Key` header (`FLUENT_AI_KEY`):
  `suggestions` from the AI trigger worker, `tools/greek-room/repeated-words` and the TTS
  routes. It calls back on `POST /ai-suggestions/internal/context` and
  `POST /ai-suggestions/internal/results` with a bearer service key (`AI_INBOUND_SERVICE_KEY`,
  checked in `src/middlewares/service-auth.ts`). Those two routes are registered with
  `server.post`, so they aren't in the OpenAPI spec.
- Aquifer (`src/lib/services/aquifer/`) and YouVersion (`src/lib/services/youversion/`) are
  read through the API's `/aquifer` and `/youversion` proxies, so their keys stay on the server.
  The Bible catalogue, source text and audio timecodes come from DBL / API.Bible
  (`src/lib/services/dbl/`).
- Recordings are found through DBL timecodes first and Aquifer second
  (`src/domains/playback-audio/`, `src/domains/source-audio/`, `src/domains/bibles/bible-audio/`).
  Generated speech comes from fluent-ai (`src/domains/ai-tools/tts.service.ts`) and is served
  back through `GET /ai/tts/audio/:file`.
- The Assistant streams from BT-Servant (`src/domains/assistant/assistant.client.ts`).
- Files go to Cloudflare R2 through the S3 API: USFM exports (`src/lib/blob-storage.ts`) and
  verse audio (`src/lib/audio-storage.ts`). Email goes through Mailgun
  (`src/lib/services/notifications/mailgun.service.ts`).
- In Postgres the API owns the `public` and `drizzle` schemas and pg-boss's `pgboss` schema, and
  fluent-ai owns `ai`. The roles are set up by `src/db/scripts/provision-db.ts` and described in
  [db-provisioning-and-setup.md](db-provisioning-and-setup.md) and fluent-platform's
  [db-ownership-separation](https://github.com/eten-tech-foundation/fluent-platform/tree/main/docs/features/db-ownership-separation).
- Logs and telemetry go to Application Insights through `src/lib/logger.ts`.

## App shell

- `src/index.ts` starts the HTTP server first and only then connects the queue, the storage
  checks and the dead-letter monitor
  ([ADR 0001](adr/0001-listen-before-initializing-external-dependencies.md)). It runs no workers.
- `src/app.ts` imports every route module. Each `*.route.ts` registers its routes on the shared
  `server` from `src/server/server.ts`, with the full path written in its `createRoute`. A route
  file that `src/app.ts` doesn't import isn't served, and searching for a path finds the file
  that serves it.
- `src/server/server.ts` sets the middleware order: error handler, request log, CORS, the
  hand-written `/api/auth/*` routes and better-auth's handler, then `authenticate` on every path.
  `src/lib/configure-open-api.ts` serves the spec at `/doc` and the Scalar UI at `/reference`.
- `src/routes/`: `GET /`, `GET /health`, `GET /config/features` (`config.route.ts`) and the
  OpenAPI entries for better-auth's routes (`auth-doc.route.ts`).
- `src/middlewares/`: `authenticate.ts` (session or bearer token, loads the user and grants),
  `role-auth.ts` (`authenticateUser`, `requirePermission` and the other guards), `service-auth.ts`
  (fluent-ai's callbacks) and `rate-limit.ts` (only on `POST /bibles/:bibleId/bulk-texts`).
  Guards that load a domain's resource sit in that domain as `*-auth.middleware.ts`.
- `src/env.ts` validates the environment with Zod, the `EN_FEATURE_*` flags included.

## Domains

Each folder in `src/domains/` is one domain. Sub-folders with their own route, service and
repository are leaves of that domain.

### Projects and work

- `src/domains/projects/`: projects and their team (`project.policy.ts`), with the leaves
  `books/`, `users/`, `chapter-assignments/` and `workflow-stages/`, and creating a project from
  USFM files (`usfm-import.service.ts`). Routes: `GET|POST /projects`,
  `GET|PATCH|DELETE /projects/:id`, `GET /projects/:projectId/books`,
  `GET|POST /projects/:projectId/users`, `PATCH|DELETE /projects/:projectId/users/:userId`,
  `GET|DELETE /projects/:projectId/chapter-assignments` with `GET .../progress`,
  `PATCH .../assign-all`, `PATCH .../assign-selected` and `PATCH .../reset-selected`, and the
  workflow stages under `/projects/:projectId/workflow-stages`. fluent-web's `features/projects`
  and `useChapterAssignment` call them.
- `src/domains/milestones/`: a project's milestones and the USFM milestone import
  (`milestone-usfm-import.route.ts`). Routes: `GET|POST /projects/:projectId/milestones`,
  `GET|PATCH|DELETE /projects/:projectId/milestones/:milestoneId`,
  `POST /projects/:id/milestones/usfm-validation` and `POST /projects/:id/milestones/import`.
  fluent-web's Add Milestone dialog and its USFM Import tab call them.
- `src/domains/chapter-assignments/`: one chapter's assignment: drafter and peer checker,
  status and stage moves (`chapter-assignments.transitions.ts`), submit, claim and the AI
  switch, with `chapter-assignments.policy.ts`. The leaves are `editor-state/`, `presence/` and
  `progress/`. Routes: `POST /chapter-assignments`,
  `GET|PATCH|DELETE /chapter-assignments/:chapterAssignmentId`,
  `PATCH /chapter-assignments/:id/submit`, `POST /chapter-assignments/:chapterAssignmentId/claim`,
  `PATCH /chapter-assignments/:chapterAssignmentId/ai-status`,
  `GET|PUT /chapter-assignments/:id/editor-state` and
  `POST|DELETE /chapter-assignments/:id/presence`. fluent-web's drafting page calls submit, the
  AI switch, the editor state and presence.
- `src/domains/translated-verses/`: drafted verse text and its markers. Routes:
  `GET|POST /translated-verses` and `GET /translated-verses/:id`. fluent-web's drafting page
  saves through `POST /translated-verses`.
- `src/domains/book-details/`: a milestone's book metadata (`\toc1` to `\toc3`). Routes:
  `GET /project-units/:id/book-details` and
  `PATCH /project-units/:projectUnitId/book-details/:bookId`, from fluent-web's book metadata
  dialog.
- `src/domains/usfm/`: USFM export. `POST /project-units/:id/usfm` returns the ZIP right away
  and is the one fluent-web's export dialog uses. `POST /project-units/:projectUnitId/usfm/async`
  queues the export for the worker, followed by `GET /jobs/:jobId` and `GET /downloads/:filename`.
  `GET /project-units/:projectUnitId/usfm/books` lists what can be exported.
- `src/domains/self/`: the signed-in user's own data: `GET /self/projects`, `GET /self/milestones`,
  `GET /self/chapter-assignments`, `GET /self/chapter-assignments/all` and
  `GET|PUT /self/settings`. fluent-web only uses the settings (the repeated word check and the AI
  preference).
- `src/domains/users/`: users and the active organization (`user.policy.ts`). Routes:
  `GET|POST /users`, `POST /users/invite`, `GET /users/email/:email`,
  `GET|PATCH|DELETE /users/:id`, `PATCH /users/me/active-org`,
  `GET /users/:id/chapter-assignments`, `GET /users/:userId/chapter-assignments/all`,
  `GET /users/:userId/milestones` and `GET /users/:id/projects`. fluent-web's users,
  organizations and dashboard features and the organization switcher call them. CONTRIBUTING.md
  names this domain as the reference for auth guards and tests.
- `src/domains/organizations/`: organizations and their members (`users/`). Routes:
  `GET|POST /organizations`, `GET /organizations/:orgId`, `GET /organizations/:orgId/users` and
  `PATCH|DELETE /organizations/:orgId/users/:userId`, from fluent-web's `features/organizations`
  and `features/users`.
- `src/domains/user-roles/`: role grants. No routes; `authenticate` loads a user's grants from it.

### Scripture and catalogue

- `src/domains/bibles/`: the Bible catalogue, with the leaves `bible-texts/` (source text) and
  `bible-audio/`, and `sync/` for the DBL catalogue sync. Routes: `GET|POST /bibles`,
  `GET /bibles/search`, `GET /bibles/language/:languageId`, `GET|PATCH|DELETE /bibles/:id`,
  `GET /bibles/:bibleId/books/:bookId/chapters/:n/texts`,
  `GET /bibles/:bibleId/books/:bookId/chapters/:chapterNumber/audio` and
  `POST /bibles/:bibleId/bulk-texts` (for mobile sync, anonymous and rate limited). fluent-web
  calls the search, the by-language list and the chapter texts.
- `src/domains/bible-books/`: `GET /bible-books/bible/:bibleId`, the books one Bible has, used
  when a project is created in fluent-web.
- `src/domains/books/`: the book catalogue (`GET /books`, `GET /books/old-testament`,
  `GET /books/new-testament`, `GET /books/:id`, `GET /books/code/:code`) and its DBL sync.
- `src/domains/languages/`: languages (`GET /languages`, `GET /languages/:id`), the Ethnologue
  import (`import/`) and the DBL sync. fluent-web's project creation lists them.
- `src/domains/bible-provider-resources/`: one Bible's identity across providers
  (`bible-provider-resources.identity.ts`). No routes.
- `src/domains/pericopes/`: pericope sets (`GET /pericope-sets`, and `GET /pericope-sets/:id` with
  ETags for mobile, see [pericope-set-sync.md](guides/pericope-set-sync.md)) and a chapter's
  pericopes (`GET /projects/:projectId/pericopes/:bookCode/:chapter`, from fluent-web's
  `features/pericopes`).
- `src/domains/aquifer-resources/`: the Aquifer proxy for fluent-web's Resources tab:
  `GET /aquifer/languages`, `GET /aquifer/languages/available-resources`,
  `GET /aquifer/resources/collections/:code`, `GET /aquifer/resources/search`,
  `GET /aquifer/resources/:contentId`, `GET /aquifer/resources/:parentResourceId/associations`,
  `GET /aquifer/bibles` and `GET /aquifer/bibles/:bibleId/texts`.
- `src/domains/youversion/`: the YouVersion proxy for the same tab: `GET /youversion/bibles` and
  `GET /youversion/bibles/:bibleId/books/:bookId/chapters/:chapterId/text`.
- `src/domains/translation-resources/`: Aquifer notes, questions and images for a verse or a
  chapter, plus a manifest, under `/projects/:projectId/translation-resources/`
  (`GET .../notes/:bookCode/:chapter/:verse` and the same for `questions` and `images`, each with
  a chapter form too, and `GET /projects/:projectId/translation-resources/manifest`). fluent-web
  uses `/aquifer` instead.

### Audio

- `src/domains/playback-audio/`: source and reference audio for fluent-web's players:
  `GET /projects/:id/playback-audio/:bookCode/:chapter`,
  `GET /projects/:id/reference-audio/:bibleKey/:bookCode/:chapter` and
  `GET /projects/:id/bible-resources/:bibleKey` (`features/tts`).
- `src/domains/source-audio/`: the same lookup with an offline manifest:
  `GET /projects/:projectId/source-audio/:bookCode/:chapter` and
  `GET /projects/:projectId/source-audio/manifest`. fluent-web uses `playback-audio` instead.
- `src/domains/verse-audio/`: recorded takes. Uploads are `PUT /verse-audio/:projectUnitId/:bibleTextId`
  and `PUT /verse-audio/:projectUnitId/range`; reads are `GET /verse-audio` and
  `GET /verse-audio/:projectUnitId/:bibleTextId`; deletes are
  `DELETE /verse-audio/:projectUnitId/:bibleTextId` and
  `DELETE /verse-audio/:projectUnitId/:bibleTextId/takes/:takeId`. fluent-web's audio review page
  calls `GET /verse-audio` and `POST /verse-audio/:projectUnitId/:bibleTextId/resolve`.
  `verse-audio.reclaim.service.ts` deletes stored files nothing points to.

### AI

- `src/domains/ai-suggestions/`: AI verse and pericope suggestions (`ai-suggestions.policy.ts`).
  fluent-web's drafting page calls `GET /ai-suggestions`, `POST /ai-suggestions/queue-next`,
  `POST /ai-suggestions/usage`, `POST /ai-suggestions/queue-pericopes`,
  `GET /ai-suggestions/pericopes` and `POST /ai-suggestions/pericopes/usage`.
  `ai-suggestions.internal.route.ts` holds fluent-ai's two callbacks. The flow is in
  [ai-suggestions-workflow.md](ai-suggestions-workflow.md).
- `src/domains/ai-tools/`: calls into fluent-ai's tools: `POST /ai/tools/greek-room/repeated-words`
  (fluent-web's repeated word check), `POST /ai/tts/generate` and `GET /ai/tts/audio/:file`
  (generated speech for `features/tts`).
- `src/domains/assistant/`: the drafting Assistant, streamed from BT-Servant with a cache and
  receipts: `GET /projects/:id/assistant/languages`, `POST /projects/:id/assistant/briefing` and
  `POST /projects/:id/assistant/turns`, from fluent-web's `features/assistant`.

## Workers

Workers run in their own process, `src/workers/standalone-worker.ts` (`npm run worker`, or the
`worker` service in `compose.yaml`), never inside the API. It refuses to start without the R2
credentials, deletes expired exports every hour and starts:

- `usfm-export.worker.ts`: builds the ZIP for `POST /project-units/:projectUnitId/usfm/async` and
  stores it in R2 (queue `usfm-export`).
- `ai-trigger.worker.ts`: sends queued AI suggestion work to fluent-ai's `suggestions`, five jobs
  at a time (queue `ai-suggestions`).
- `ingest-bible-text.worker.ts`: ingests DBL chapter text (`dbl-ingest-text` and
  `dbl-ingest-text-priority`) and turns imported USFM into verses (`usfm-import-materialize`).
- `usfm-import-recovery.ts`: every 60 seconds, queues again the USFM imports still pending.
- `queue-heartbeat.ts`: queue metrics every 5 minutes.

`dbl-sync.worker.ts` defines a `dbl-sync` worker that nothing starts. The catalogue sync runs
with `npm run db:sync:dbl`. Queue names are in `QUEUE_NAMES` (`src/lib/queue.ts`), and retries
and dead letters are in `src/lib/dead-letter-queues.ts` and the
[dead-letter runbook](runbooks/worker-dead-letter-queues.md).

## Database

- `src/db/schema.ts` holds every table and enum, and `src/db/index.ts` the client.
- `src/db/migrations/` holds the SQL migrations and `meta/_journal.json`. Make one with
  `npm run db:generate <name>` and apply it with `npm run db:migrate`;
  [CONTRIBUTING.md](../CONTRIBUTING.md#database-changes) has the rules.
- `src/db/seeds/` holds the seeds (`npm run db:seed:*`, with the demo data in `demo/`), and
  `src/db/scripts/` the setup, provisioning, user and one-off data scripts behind the other
  `db:*` scripts. `src/db/env-configs/` holds the provisioning settings for each environment.
- `src/db/transaction.ts`: `runInTransaction`, which commits on `ok()` and rolls back on `err()`.
- `src/db/testing/` creates the catalogue schema for the PGlite tests.

## Shared code

- Auth: `src/lib/auth.ts` (better-auth), `src/lib/permissions.ts` (permission names),
  `src/lib/roles.ts` (role names) and `src/lib/services/permissions/` (`authorize()`).
- Queues: `src/lib/queue.ts` (pg-boss), `src/lib/dead-letter-queues.ts` and
  `src/lib/pg-boss-schema.ts`.
- `src/lib/features.ts`: the runtime flags behind `GET /config/features`.
- `src/lib/usfm-converter.ts` and `src/lib/usfm-verse-serializer.ts`: USFM to verse rows and back.
- `src/lib/types.ts`: `Result`, `AppError`, `ErrorCode` and the mapping from error to status.
- `src/lib/services/`: the clients for fluent-ai, Aquifer, YouVersion and DBL, and Mailgun.
- `src/test/utils/test-helpers.ts`: mock contexts and fixtures. Tests sit next to the code they
  cover. `npm test` runs every `*.test.ts` except `*.db.test.ts` (`npm run test:db`, which needs
  the local Postgres) and `*.live.test.ts` (`npm run test:live`, which calls Aquifer).

## Feature docs

`docs/features/` holds the proposals, designs and plans behind most features. Some status lines
there are out of date, so check the code before you rely on one: `ai-suggestions-internal-consolidation`
says it isn't implemented, but the internal routes already live in `ai-suggestions`, and
`http-decoupling-transition` and [cross-schema-types.md](cross-schema-types.md) still describe
`src/db/external/`, which is gone.

- Auth and access: `authentication-migration`, `betterauth-scripts-and-seeds`, `user-centric-rbac`,
  `org-onboarding`, `account-self-management`.
- Projects and scripture: `milestones`, `usfm-import`, `section-heading-storage`,
  `ethnologue-language-import`, `security-and-export-hardening`, `api434-display-mode`.
- Audio: `source-audio`, `selected-canonical-hydration`.
- AI: `pericope-ai-suggestions`, `repeated-word-check`, `ai-suggestions-internal-consolidation`,
  `http-decoupling-transition`, `ai-assistant-passage-briefing`.
- Flags, QA and tooling: `feature-flags`, `qa-demo-seed`, `qa-environment-and-release-tooling`,
  `ci-max-line-annotations`.

How-to guides are in `docs/guides/` (code standards, the catalogue watermark, pericope set sync,
chapter resolution), operations in `docs/runbooks/`, and decisions in `docs/adr/`.
