# Node.js 26 Upgrade — Fluent API

## Problem Statement

The repo pins Node.js 24.14.x in `.nvmrc`, `Dockerfile.dev` (digest-pinned base
image), and four GitHub Actions workflows, while `engines` declares
`>=24.14.0`. Node.js 26 ("Lithium") became the Active LTS on 2026-10-28 with
support through April 2029; Node 24 moves to Maintenance LTS in October 2027.

Unlike fluent-web, the runtime that matters most is not in the repo at all:
production code runs on an Azure App Service (Linux) Web App plus a continuous
WebJob under `App_Data/jobs`, both executing under the app's configured Node
stack (currently `NODE|24-lts`). The deployment package ships `node_modules`
installed and compiled in CI, so the CI Node version and the Azure runtime
version must move in the same release — upgrading only one side leaves the
service running a runtime its dependencies were never tested against.

## Solution

Bump every in-repo pin to 26.13.x in a single PR, bump `@types/node`, and roll
the App Service runtime to `NODE|26` per environment in step with the deploy
pipeline: Development on merge to main, QA at release-tag deploy, Production at
promotion — the last step gated on `NODE|26` reaching General Availability on
App Service (it has been in preview since 2026-09-11). No source code changes
and no dependency upgrades are required: every `engines` range in
`package-lock.json` is open-ended, the codebase uses none of the APIs removed
in Node 25/26, and the sole native dependency (tree-sitter via `usfm-grammar`)
is an ABI-stable N-API addon.

## User Stories

1. As a developer, I want `nvm install` / `nvm use` to give me the Node version
   the project runs, so that local matches CI and the deployed runtime.
2. As a developer, I want `npm ci`, `npm run dev`, `npm run test`, and
   `npm run verify` to work on Node 26, so that local verification is
   meaningful.
3. As a developer, I want `fapi.sh` / `compose.yaml` to build the api and
   worker images on Node 26, so that the containerized dev workflow keeps
   working.
4. As a developer, I want the tree-sitter native addon to keep working on
   Node 26's V8 14.6, so that USFM parsing via `usfm-grammar` is unaffected.
5. As a contributor reading the README, I want the documented Node prerequisite
   to match `.nvmrc`, so that setup instructions are trustworthy.
6. As CI, I want install, lint, typecheck, tests, build, and WebJob packaging
   to run on the same Node major that executes the app in Azure, so that the
   artifact is built on what it runs on.
7. As the release pipeline, I want the deploy job's `npm install` (used for the
   migration step) and the `node_modules` shipped in the deployment package to
   be built on the same major as the App Service runtime, so that compiled
   artifacts match.
8. As an operator, I want each environment's Web App stack moved to `NODE|26`
   at the moment its deploy lands, so that the API and the continuous WebJob
   never run a version their dependencies weren't built on.
9. As an operator, I want the existing `/health` version assertion in the
   deploy workflow to catch a runtime mismatch, so that a bad stack change is
   surfaced by the pipeline rather than discovered later.
10. As a maintainer, I want `@types/node` to match the runtime major, so that
    type checking reflects the real platform APIs.
11. As a maintainer, I want a single atomic PR for the repo side, so that no
    intermediate state exists where environments disagree on the Node major.
12. As a maintainer, I want Production to move only after `NODE|26` is GA on
    App Service, so that we don't run prod on a preview runtime.
13. As a maintainer, I want to stay on a supported LTS line, so that the
    service keeps receiving security and bug-fix releases through April 2029.
14. As a developer, I want the WebJob (`run.mjs` under `App_Data/jobs`) to keep
    resolving the shared `node_modules` at `wwwroot` under Node 26, so that the
    run-from-package design in ADR-0002 is preserved.

## Implementation Decisions

- **Single coordinated repo bump.** `.nvmrc`, `Dockerfile.dev`, all CI
  `node-version` pins, `engines`, and `@types/node` move in one PR. The Azure
  stack change is deliberately sequenced *with* deploys (below), not in the PR.
- **Target version 26.13.x** — the first LTS release (26.13.0, "Lithium",
  2026-10-28).
- **`engines.node`: `">=24.14.0"` → `">=26.13.0"`.** Keep the repo's floor
  style (not a pin): the floor documents the oldest supported runtime, and CI
  plus the Azure stack supply the actual version.
- **`Dockerfile.dev`: re-pin the digest to `node:26.13.x-alpine3.23` (or the
  closest alpine3.2x tag published).** Keep the existing digest-pinning and
  `--ignore-scripts` + `npm rebuild` pattern; the python3/make/g++ toolchain
  stays because `npm ci` still compiles against V8 headers.
- **CI workflows: `node-version` → `26.13.0`** in `pre-merge.yml` (four jobs),
  `test-version-injection.yml`, `build.yml`, and `deploy.yml`. The
  `CXXFLAGS=-std=c++20` install workaround stays — tree-sitter and the
  antfu-config markdown formatter still compile native code at install.
- **`@types/node`: `24.1.0` → `^26`.**
- **Regenerate `package-lock.json` via `npm install` on Node 26** — expected
  near-no-op; no dependency versions change.
- **No dependency upgrades.** Every `engines` range in the lockfile is
  open-ended. `tree-sitter` (pinned to 0.25.1 by the `overrides` entry for
  `usfm-grammar`) is built with `node-addon-api` and ships N-API prebuilds —
  N-API is forward-compatible across Node majors, so it loads on ABI 147
  without a version bump. tsx, drizzle-kit, pg-boss, `@hono/node-server`,
  `applicationinsights`, and `@electric-sql/pglite` are all pure-JS/WASM and
  unaffected.
- **No source changes.** The codebase uses none of the APIs removed in
  Node 25/26 (`SlowBuffer`, `fs.rmdir` recursive, `fs.F_OK` family,
  `assert.CallTracker`, `process.multipleResolves`, falsy `dns.lookup`
  hostname). Node 26 enabling `localStorage`/`sessionStorage`/`ErrorEvent`
  globals changes nothing — no server code branches on them.
- **Runtime rollout is per-environment, coupled to the deploy that ships the
  new artifact:**
  1. Merge → post-merge deploy to **Development**; set the dev Web App stack to
     `NODE|26` as part of that deploy (CLI:
     `az webapp config set --linux-fx-version "NODE|26"`). The `/health`
     version assertion in `deploy.yml` is the smoke test.
  2. Next release tag → **QA** deploy; flip the QA Web App stack with it.
  3. `promote-to-prod` → **Production**; flip the prod stack — **only if
     `NODE|26` is GA on App Service by then.** If it is still preview-only,
     hold prod at `NODE|24-lts`; the repo supports either since `engines` is a
     floor, and dev/QA running 26 while prod runs 24 for a short window is
     acceptable but should be time-boxed.
- **The continuous WebJob needs no change.** It runs `node run.mjs` under the
  app's configured runtime and resolves `wwwroot/node_modules` by upward
  resolution (ADR-0002); it inherits the stack flip automatically.
- **Node 26 App Service image deltas don't affect this app.** The `NODE|26`
  image is Ubuntu 26.04-based and drops system Python, Corepack, and the global
  App Insights package — the service ships prebuilt `node_modules`, starts via
  `npm start`, and uses the `applicationinsights` npm package, so none of those
  removals apply.
- **Docs updates.** README prerequisites move from "24.14.0" to "26.13.x"; the
  C++20/`node-gyp` install note stays.

## Testing Decisions

This is a toolchain change, not a feature change — verification is the repo's
existing check surface plus the pipeline's existing deploy assertions. No new
test seams are introduced; everything is exercised at the highest seam that
already exists.

- **What makes a good test here:** external behavior only — install succeeds,
  checks pass, the server boots (including its degraded-startup path), the
  worker runs, migrations apply, `/health` reports the deployed version.
  Nothing asserts on the Node binary.
- **Local seam: `npm run verify`.** The repo's full gate
  (precheck = lint + format + typecheck + vitest, plus deadcode, docs check,
  and build) run on Node 26.13.x. Vitest exercises application behavior; the
  `test:db` suite additionally exercises the PGlite WASM dependency on the new
  V8.
- **Docker seam: `fapi.sh` image build + `compose.yaml` api/worker boot.** The
  entrypoint runs the db bootstrap/setup path via tsx, which is the heaviest
  realistic startup workload — it compiles/loads tree-sitter and runs
  migrations inside the container.
- **CI seam: the `pre-merge.yml` and `build.yml` runs on the upgrade PR
  itself.** Install (with native compilation under C++20), lint, typecheck,
  unit tests, `tsc` build, prod `npm install`, and WebJob packaging all run on
  26 — the PR is self-verifying.
- **Deploy seam: `deploy.yml`'s post-deploy `/health` assertion.** Already the
  pipeline's proof that the new artifact actually landed and is running; it is
  also the canary for a botched stack flip, since a runtime that can't load the
  shipped `node_modules` fails health before verification succeeds.
- **Prior art:** the Node 24 bump that set the current pins; this change
  follows the same shape, adding the per-environment stack flips.

## Out of Scope

- Upgrading any dependency (including npm, which ships bundled with Node 26 at
  11.20).
- TypeScript, Vitest 3→4, ESLint, drizzle, Hono, or other toolchain-major
  upgrades.
- Supporting Node 24 and 26 simultaneously long-term — environments may briefly
  disagree during the staged rollout only.
- Changes to fluent-web (covered by its own spec; fluent-web upgrades first).
- Changing the deployment model (run-from-package, WebJob layout,
  `Dockerfile.dev`'s dev-only role) — ADR-0002 stands.
- Docker-based production deployment — prod ships the zip artifact to the Web
  App; `Dockerfile.dev` is dev-only.
- Adopting new Node 26 platform features (Temporal, Web Storage in Node,
  `--allow-net` permissions, etc.).

## Further Notes

- Node 26 ships V8 14.6, npm 11.20, Undici 8; module ABI is 147. The service's
  `fetch` usage is standard and unaffected by Undici 8.
- Known upstream footgun (not a blocker): nodejs/node#64500 — concurrent
  PGlite WASM initialization can intermittently SIGSEGV under V8 tier-up; it
  reproduces on Node 22–26 alike, so upgrading neither causes nor worsens it.
  Worth knowing if `test:db` ever flakes in CI.
- Official Node 26 Linux binaries link against `libatomic`; official images and
  the App Service runtime handle this internally.
- The App Service Node 26 runtime identifier is `NODE|26` — note the new
  identifier style drops the `-lts` suffix that `NODE|24-lts` uses
  (azure-cli#33864, merged August 2026).
- Node 26 no longer bundles Corepack — irrelevant here (npm is used), noted
  only because fluent-web's Dockerfile needed a workaround for the same change.
