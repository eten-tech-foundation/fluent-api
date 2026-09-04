# fluent-api: QA Environment, Commit Picker & Tag Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert a QA deployment stage with manual sign-off between tag-cut and prod deploy, let release-cutters pick which commit on `main` gets tagged, add a deploy-only rollback path, and lock down `v*` release tags against tampering — all on top of the already-shipped CalVer tag-triggered pipeline in `fluent-api`.

**Architecture:** Extends the existing `.github/workflows/cut-release.yml` and `post-merge-deploy.yml` in place. QA gets its own fully isolated Azure Web App and database — never shares state with prod — so a QA sign-off is meaningful. The approval gate is a dedicated zero-secrets `Production-Approval` GitHub Environment with required reviewers, so reviewers get "permission to unblock," not incidental prod access. Rollback lives in a separate workflow file rather than branching the main deploy workflow's conditional logic further. Provider portability (containerization + GHCR + Fly.io swap-out) and cross-repo SHA-pinning/CodeQL hardening are explicitly **out of scope** for this plan — tracked as separate follow-on plans per `fluent-platform/docs/superpowers/specs/2026-08-06-cicd-pipeline-design.md`. **Accepted debt (per the spec's "Sequencing" section):** the new QA/rollback jobs here are built on the current Azure Web App zip-artifact deploy mechanism, which the design spec designates as temporary — the `deploy-*` job internals will be reworked when api containerizes; the pipeline shape (build → deploy-qa → approve-prod → migrate-prod → deploy-prod) is what carries forward.

**Tech Stack:** GitHub Actions, Bash, `jq`, `gh` CLI, `fzf`, Azure Web Apps (`azure/webapps-deploy`), Drizzle Kit migrations, `actionlint` for workflow validation.

## Global Constraints

- CalVer tag format is exactly `vYY.MM.SERIAL` — validated against `^v[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]*$` (already enforced in both `cut-release.yml` and `post-merge-deploy.yml`; do not weaken this regex).
- Node version pinned at `24.14.0` everywhere a workflow sets up Node (match existing jobs exactly).
- `actions/checkout` stays at whatever version/pin is already in each file being edited — do not change unrelated checkout versions as part of this plan (that's the separate SHA-pinning plan's job).
- QA must be a **fully isolated** instance: its own Azure Web App, its own database, never sharing state with prod or dev.
- The `Production-Approval` environment must hold **zero secrets** — it exists only as an approval gate, so granting someone reviewer access there never grants incidental access to production credentials.
- No new tag gets cut for prod promotion — QA and prod both deploy from the same `vYY.MM.N` tag.
- Every new/modified workflow file must pass `actionlint` with zero errors before being committed.

---

## File Structure

- Modify: `.github/workflows/cut-release.yml` — add `commit` input + ancestry validation (Task 1)
- Create: `scripts/cut-release.sh` — local commit-picker (Task 2)
- Modify: `.github/workflows/post-merge-deploy.yml` — add `migrate-qa`, `deploy-qa`, `approve-prod` jobs; gate `migrate-prod` on `approve-prod` (Task 4)
- Create: `.github/workflows/deploy-rollback.yml` — deploy-only path, skips migration (Task 5)
- Modify: `.github/workflows/pre-merge.yml` — coverage threshold gate (Task 8)
- Create: `docs/runbooks/deployment/prod-release-cut.md`
- Create: `docs/runbooks/deployment/prod-hotfix-during-qa.md`
- Create: `docs/runbooks/deployment/prod-emergency-hotfix.md`
- Create: `docs/runbooks/deployment/prod-rollback.md`
- Modify: `docs/calver-versioning.md` — document the QA stage and commit picker
- Modify: `README.md` or `CONTRIBUTING.md` — note the `fzf` local dependency

---

### Task 1: Commit picker input on `cut-release.yml`

**Files:**

- Modify: `.github/workflows/cut-release.yml`

**Interfaces:**

- Produces: a `commit` workflow input, defaulting to blank (meaning `main`'s tip). Downstream: the `tag` job checks out `inputs.commit || 'main'`.

- [ ] **Step 1: Install `actionlint` locally for validation**

```bash
# macOS
brew install actionlint
# or download a release binary: https://github.com/rhysd/actionlint/releases
actionlint --version
```

- [ ] **Step 2: Baseline — confirm the current file passes actionlint**

Run: `actionlint .github/workflows/cut-release.yml`
Expected: no output (zero errors) — this is the pre-change baseline.

- [ ] **Step 3: Add the `commit` input and checkout-ref wiring**

Edit `.github/workflows/cut-release.yml`:

```yaml
name: Cut release
on:
  workflow_dispatch:
    inputs:
      commit:
        description: 'Commit SHA on main to release (leave blank for latest main)'
        required: false
        type: string

concurrency: release

jobs:
  tag:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v7.0.0
        with:
          ref: ${{ inputs.commit || 'main' }}
          fetch-depth: 0 # need full tag history to compute the next serial
          token: ${{ secrets.BOT_TOKEN }}
          persist-credentials: true

      - name: Validate chosen commit is on main
        if: inputs.commit != ''
        env:
          COMMIT: ${{ inputs.commit }}
        run: |
          git fetch origin main --quiet
          if ! git merge-base --is-ancestor "$COMMIT" origin/main; then
            echo "::error::Commit $COMMIT is not reachable from main. Choose a commit already merged to main."
            exit 1
          fi
          echo "Commit $COMMIT confirmed on main."

      - name: Compute CalVer tag
        id: version
        run: |
          YEAR_MONTH=$(date +'%y.%m')
          SERIAL=$(git tag -l "v${YEAR_MONTH}.[0-9]*" | sed -E "s/^v${YEAR_MONTH}\.//" | sort -n | tail -1)
          SERIAL=${SERIAL:-0}
          NEXT=$((SERIAL + 1))
          TAG="v${YEAR_MONTH}.${NEXT}"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Computed tag: $TAG"

      - name: Validate CalVer tag format
        env:
          TAG: ${{ steps.version.outputs.tag }}
        run: |
          if [[ ! "$TAG" =~ ^v[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]*$ ]]; then
            echo "::error::Tag '$TAG' does not match required CalVer format vYY.MM.SERIAL (e.g. v26.07.1)"
            exit 1
          fi
          echo "Tag '$TAG' is valid."

      - name: Tag and push
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git tag ${{ steps.version.outputs.tag }}
          git push origin ${{ steps.version.outputs.tag }}

      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ steps.version.outputs.tag }}
          generate_release_notes: true
```

Note: `inputs.commit` is passed through `env:` and referenced as `"$COMMIT"` rather than interpolated directly into the `run:` script — a `workflow_dispatch` string input is attacker-controllable text, so quoting through an env var avoids template-injection.

- [ ] **Step 4: Run actionlint against the edited file**

Run: `actionlint .github/workflows/cut-release.yml`
Expected: no output (zero errors). If actionlint flags the new step, fix before proceeding — do not commit a file actionlint rejects.

- [ ] **Step 5: Manual dry-run verification (real workflow, real repo)**

This step can't be unit-tested — it's GitHub Actions behavior against live tag/branch state. Verify by hand once:

1. Push this change to a branch, open a PR, merge to `main` (or push directly if repo policy allows for this verification).
2. From the Actions tab, run "Cut release" with `commit` left blank — confirm it tags `main`'s current tip as usual (no behavior change from before).
3. Run "Cut release" again with `commit` set to an older SHA on `main` (e.g. `git log --oneline -5` and pick one two commits back) — confirm the tag is created pointing at that older commit, not at `main`'s tip.
4. Run "Cut release" with `commit` set to a SHA that is **not** on `main` (e.g. a commit from a feature branch) — confirm the job fails at "Validate chosen commit is on main" with the expected error, and no tag is created.
5. Delete any throwaway tags created during this verification (`git push origin :refs/tags/<tag>` and `git tag -d <tag>` locally) so they don't collide with the next real release's computed serial.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/cut-release.yml
git commit -m "feat(release): allow cutting a release from an explicit commit on main"
```

---

### Task 2: Local commit-picker script

**Files:**

- Create: `scripts/cut-release.sh`
- Modify: `README.md` (or `CONTRIBUTING.md`, whichever documents local dev prerequisites — check which one lists things like Node version before choosing)

**Interfaces:**

- Consumes: `inputs.commit` from Task 1's `cut-release.yml`.
- Produces: a `gh workflow run cut-release.yml -f commit=<sha>` invocation — no other task depends on this script's internals.

- [ ] **Step 1: Confirm `shellcheck` is available for validation**

```bash
shellcheck --version
# macOS: brew install shellcheck
```

- [ ] **Step 2: Write the script**

Create `scripts/cut-release.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

git fetch origin main --quiet
COMMIT=$(git log --oneline -30 origin/main | fzf --prompt="Pick a commit to release: " | cut -d' ' -f1)
[ -n "$COMMIT" ] || { echo "No commit selected"; exit 1; }
echo "Cutting release from commit: $COMMIT"
gh workflow run cut-release.yml -f commit="$COMMIT"
```

Make it executable:

```bash
chmod +x scripts/cut-release.sh
```

- [ ] **Step 3: Run shellcheck**

Run: `shellcheck scripts/cut-release.sh`
Expected: no warnings/errors. Fix any that appear (e.g. quoting) before proceeding.

- [ ] **Step 4: Manual verification**

Requires local `gh` auth and `fzf` installed. Run `./scripts/cut-release.sh`, pick a commit from the fzf list, confirm it prints "Cutting release from commit: <sha>" and successfully calls `gh workflow run` (check the Actions tab for the triggered run). Cancel/don't let it actually tag unless you intend a real release.

- [ ] **Step 5: Document the `fzf` dependency**

Check whether `README.md` or `CONTRIBUTING.md` lists local dev prerequisites (Node version, etc.) — add a line near that existing list:

```markdown
- [`fzf`](https://github.com/junegunn/fzf#installation) — required for `scripts/cut-release.sh` (interactive commit picker for cutting releases)
```

- [ ] **Step 6: Commit**

```bash
git add scripts/cut-release.sh README.md
git commit -m "feat(release): add local commit-picker script for cut-release.yml"
```

---

### Task 3: Provision QA infrastructure prerequisites

**Files:** none (Azure portal / `az` CLI + GitHub repo Settings — infrastructure provisioning, not application code)

This task has no automated test cycle — it's cloud resource provisioning. Treat each checklist item as a manual verification gate instead of a code test.

- [ ] **Step 1: Create the QA Azure Web App**

Mirror the naming convention already used for dev (`scribe-server-dev`) and prod (`fluent-server-prod`) — e.g. `fluent-server-qa`. Use whatever provisioning method the existing dev/prod App Services were created with (check `fluent-platform/deploy/azure/bicep` for an existing template to extend, or use the Azure Portal / `az webapp create` matching the existing App Service Plan's tier and region).

- [ ] **Step 2: Download the QA Web App's publish profile and add it as a repo secret**

```bash
az webapp deployment list-publishing-profiles \
  --name fluent-server-qa \
  --resource-group <same-resource-group-as-dev-and-prod> \
  --xml
```

Add the output as a new GitHub Actions secret named `AZUREAPPSERVICE_PUBLISHPROFILE_QA` (Repo → Settings → Secrets and variables → Actions).

- [ ] **Step 3: Provision an isolated QA database**

Create a QA-only Postgres database (separate from dev and prod — check how the prod/dev databases were provisioned, likely Azure Database for Postgres per an existing resource, and mirror that for QA). Add its connection string as secret `DATABASE_URL_QA`.

- [ ] **Step 4: Create the `QA` GitHub Environment**

Repo → Settings → Environments → New environment → name it `QA`. No required reviewers needed here (QA deploys automatically after a tag push) — reviewers belong on `Production-Approval` (Task 4), not here.

- [ ] **Step 5: Verify secrets are visible to the right environment scope**

Confirm `AZUREAPPSERVICE_PUBLISHPROFILE_QA` and `DATABASE_URL_QA` are either repo-level secrets or scoped to the `QA` environment specifically (repo-level is simpler and matches how `DATABASE_URL_DEV`/`DATABASE_URL_PROD` are already scoped today — check their current scope in Settings → Secrets and mirror it).

- [ ] **Step 6: Record what was provisioned**

Note the resource group, region, and App Service Plan tier used for `fluent-server-qa` somewhere durable (e.g. a comment in this plan file, or `fluent-platform/deploy/azure/env/staging.env` if that's where QA env values are meant to live) so it isn't lost — this is a Settings/infra change with no PR diff to document it otherwise.

---

### Task 4: QA deploy stage + prod approval gate

**Files:**

- Modify: `.github/workflows/post-merge-deploy.yml`

**Interfaces:**

- Consumes: `AZUREAPPSERVICE_PUBLISHPROFILE_QA`, `DATABASE_URL_QA` secrets from Task 3; the `QA` and `Production-Approval` GitHub Environments.
- Produces: `deploy-qa` job output `webapp-url` (mirrors `deploy-dev`/`deploy-prod`'s existing pattern). `migrate-prod` now depends on `approve-prod` in addition to `build`.

- [ ] **Step 1: Baseline — confirm current file passes actionlint**

Run: `actionlint .github/workflows/post-merge-deploy.yml`
Expected: no errors.

- [ ] **Step 2: Create the `Production-Approval` GitHub Environment**

Repo → Settings → Environments → New environment → name it exactly `Production-Approval`. Add required reviewers (whoever should sign off QA before prod). **Do not add any secrets to this environment** — per the Global Constraints, it exists only as a gate.

- [ ] **Step 3: Add `migrate-qa` and `deploy-qa` jobs, and the `approve-prod` gate**

Edit `.github/workflows/post-merge-deploy.yml`, adding these three jobs (insert after `migrate-prod`, before `deploy-dev`/`deploy-prod` — job order in the file doesn't affect execution order, `needs:` does, but keeping related jobs grouped helps readability):

```yaml
migrate-qa:
  runs-on: ubuntu-latest
  needs: build
  if: github.ref_type == 'tag'
  environment: QA
  steps:
    - name: Checkout repository
      uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

    - name: Set up Node.js version
      uses: actions/setup-node@v6.4.0
      with:
        node-version: 24.14.0
        cache: npm

    - name: Install dependencies
      run: npm install --legacy-peer-deps
      env:
        CXXFLAGS: '-std=c++20'

    - name: Run database migrations
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL_QA }}
      run: npm run db:migrate

deploy-qa:
  runs-on: ubuntu-latest
  needs: [build, migrate-qa]
  if: github.ref_type == 'tag'
  environment:
    name: QA
    url: ${{ steps.deploy-to-webapp.outputs.webapp-url }}
  steps:
    - name: Download artifact from build job
      uses: actions/download-artifact@v8
      with:
        name: node-app
        path: deployment/

    - name: Deploy to Azure Web App
      id: deploy-to-webapp
      uses: azure/webapps-deploy@v3.0.8
      with:
        app-name: fluent-server-qa
        publish-profile: ${{ secrets.AZUREAPPSERVICE_PUBLISHPROFILE_QA }}
        package: deployment/
        clean: true

    - name: Verify deployment
      run: |
        sleep 30
        for i in $(seq 1 10); do
          response=$(curl -s -o /dev/null -w "%{http_code}" ${{ steps.deploy-to-webapp.outputs.webapp-url }})
          if [ "$response" -ge 200 ] && [ "$response" -lt 400 ]; then
            echo "QA deployment successful (HTTP $response)"
            exit 0
          else
            echo "App not ready yet (HTTP $response). Retrying in 10 seconds..."
            sleep 10
          fi
        done
        echo "QA deployment verification failed"
        exit 1

    - name: Post deployment marker
      env:
        WEBHOOK: ${{ secrets.DEPLOY_MARKER_WEBHOOK_URL }}
      run: |
        if [ -z "$WEBHOOK" ]; then echo "No DEPLOY_MARKER_WEBHOOK_URL configured; skipping marker"; exit 0; fi
        curl -fsS -X POST -H 'Content-Type: application/json' \
          -d "{\"service\":\"fluent-api\",\"environment\":\"qa\",\"tag\":\"${GITHUB_REF_NAME}\",\"sha\":\"${GITHUB_SHA}\"}" \
          "$WEBHOOK"

approve-prod:
  runs-on: ubuntu-latest
  needs: deploy-qa
  if: github.ref_type == 'tag'
  environment:
    name: Production-Approval
  steps:
    - run: echo "QA sign-off received — proceeding to production deploy."
```

- [ ] **Step 4: Gate `migrate-prod` on `approve-prod`**

Find the existing `migrate-prod` job and change its `needs:`:

```yaml
migrate-prod:
  runs-on: ubuntu-latest
  needs: [build, approve-prod]
  if: github.ref_type == 'tag'
  environment: Production
  # ...rest unchanged
```

`deploy-prod` already has `needs: [build, migrate-prod]`, so it transitively waits on the approval — no change needed to its dependencies. Do add the same "Post deployment marker" step shown in `deploy-qa` above to the end of `deploy-prod` (with `"environment":"production"`), per the design spec's observability requirement: every successful `deploy-qa`/`deploy-prod` posts a one-line greppable marker. `DEPLOY_MARKER_WEBHOOK_URL` is a repo-level secret pointing at wherever the org's monitoring lives (a Slack incoming webhook is the minimum viable version); the step degrades to a logged skip when the secret isn't configured yet, so the pipeline doesn't block on the monitoring decision.

- [ ] **Step 5: Run actionlint against the edited file**

Run: `actionlint .github/workflows/post-merge-deploy.yml`
Expected: no output. Fix and re-run if anything is flagged.

- [ ] **Step 6: Manual dry-run verification**

1. Merge this change to `main` (via normal PR).
2. Trigger "Cut release" (Task 1/2) to produce a real tag against a throwaway/test-safe commit if possible, or coordinate with the team to use the next real release for this verification.
3. Watch the Actions run: confirm `migrate-qa` and `deploy-qa` run and succeed, confirm `approve-prod` shows as "Waiting" in the Actions UI (not auto-approved).
4. Approve it as a reviewer — confirm `migrate-prod` and `deploy-prod` then run.
5. Confirm someone **without** reviewer access on `Production-Approval` cannot approve it (test with a second account if available, or verify via Settings that the reviewer list is exactly who's intended).

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/post-merge-deploy.yml
git commit -m "feat(release): add QA deploy stage with manual approval gate before prod"
```

---

### Task 5: Deploy-only rollback path

**Files:**

- Create: `.github/workflows/deploy-rollback.yml`

**Interfaces:**

- Consumes: an existing `vYY.MM.SERIAL` tag (`inputs.tag`), the already-built artifact conventions from `post-merge-deploy.yml`'s `build` job (same `npm run build` + webjob packaging steps — duplicated here rather than shared, since GitHub Actions has no first-class job-sharing across workflow files without a reusable workflow, and this file intentionally stays self-contained and simple to audit during an incident).
- Produces: a `deploy-to-webapp` step identical in shape to `deploy-prod`'s, deployed against `fluent-server-prod`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/deploy-rollback.yml`:

```yaml
name: Deploy rollback (no migration)
on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Existing vYY.MM.SERIAL tag to redeploy to production, without running migrations'
        required: true
        type: string

jobs:
  validate-tag:
    runs-on: ubuntu-latest
    steps:
      - name: Validate tag format
        env:
          TAG: ${{ inputs.tag }}
        run: |
          if [[ ! "$TAG" =~ ^v[0-9]{2}\.(0[1-9]|1[0-2])\.[1-9][0-9]*$ ]]; then
            echo "::error::Tag '$TAG' does not match required CalVer format vYY.MM.SERIAL (e.g. v26.07.1)"
            exit 1
          fi
          echo "Tag '$TAG' is valid."

  build:
    runs-on: ubuntu-latest
    needs: validate-tag
    steps:
      - name: Checkout repository at rollback tag
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          ref: ${{ inputs.tag }}

      - name: Set up Node.js version
        uses: actions/setup-node@v6.4.0
        with:
          node-version: 24.14.0
          cache: npm

      - name: Set version from tag
        run: |
          VERSION="${{ inputs.tag }}"
          VERSION="${VERSION#v}"
          jq ".version = \"$VERSION\"" package.json > tmp.json && mv tmp.json package.json

      - name: Install all dependencies
        run: npm install --legacy-peer-deps
        env:
          CXXFLAGS: '-std=c++20'

      - name: Build application
        run: npm run build

      - name: Create deployment package directory
        run: |
          mkdir -p deployment
          cp -r dist deployment/
          cp package.json deployment/
          cp package-lock.json deployment/ || true

      - name: Install production dependencies
        run: |
          cd deployment
          npm install --prod --legacy-peer-deps
        env:
          CXXFLAGS: '-std=c++20'

      - name: Add WebJob to deployment package
        run: |
          export WEBJOB_ROOT=deployment
          node scripts/setup-webjob.js

      - name: Upload artifact for deployment job
        uses: actions/upload-artifact@v7
        with:
          name: node-app-rollback
          path: deployment/

  deploy-prod:
    runs-on: ubuntu-latest
    needs: build
    environment:
      name: Production
      url: ${{ steps.deploy-to-webapp.outputs.webapp-url }}
    steps:
      - name: Download artifact from build job
        uses: actions/download-artifact@v8
        with:
          name: node-app-rollback
          path: deployment/

      - name: Deploy to Azure Web App
        id: deploy-to-webapp
        uses: azure/webapps-deploy@v3.0.8
        with:
          app-name: fluent-server-prod
          publish-profile: ${{ secrets.AZUREAPPSERVICE_PUBLISHPROFILE_PROD }}
          package: deployment/
          clean: true

      - name: Verify deployment
        run: |
          sleep 45
          for i in $(seq 1 12); do
            response=$(curl -s -o /dev/null -w "%{http_code}" ${{ steps.deploy-to-webapp.outputs.webapp-url }})
            if [ "$response" -ge 200 ] && [ "$response" -lt 400 ]; then
              echo "Rollback deployment successful (HTTP $response)"
              exit 0
            else
              echo "App not ready yet (HTTP $response). Retrying in 15 seconds..."
              sleep 15
            fi
          done
          echo "Rollback deployment verification failed"
          exit 1
```

Note: this workflow deliberately has **no migration job at all** — that's the entire point (re-running `migrate-prod` against a prior tag is the bug this fixes). It also runs against the `Production` environment, reusing whatever protection rules that environment already has — it does **not** go through `Production-Approval`, since a rollback is itself the emergency response, not a new release needing sign-off. This is the decided cross-repo policy per `fluent-platform/docs/superpowers/specs/2026-08-06-cicd-pipeline-design.md` ("Rollback: Decided"), stated explicitly in the runbook (Task 7).

- [ ] **Step 2: Run actionlint**

Run: `actionlint .github/workflows/deploy-rollback.yml`
Expected: no errors.

- [ ] **Step 3: Manual verification — prove the rollback path works, in dev first**

Do not test this against real prod on the first try. Options, in order of preference:

1. Temporarily point a copy of this workflow at the `Development` environment/`fluent-server-dev` app name and run it against an existing tag, confirming it deploys without touching any migration job, then revert the temporary change.
2. If a safe prod window exists, run it for real against the current live tag (redeploying what's already running is a no-op from the user's perspective) purely to prove the mechanism, watching that no `migrate-prod` job appears anywhere in the run.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy-rollback.yml
git commit -m "feat(release): add deploy-only rollback workflow that skips migrations"
```

---

### Task 6: Tag protection rulesets

**Files:** none (GitHub repo Settings — no code diff)

- [ ] **Step 1: Confirm the bot identity**

Determine what `secrets.BOT_TOKEN` actually authenticates as (a machine-user PAT → note that user's username; a GitHub App installation token → note the App's name). Check existing repo docs/secrets descriptions, or ask whoever set up `BOT_TOKEN` originally — do not guess.

- [ ] **Step 2: Create Ruleset A — "Restrict release tag creation"**

Repo → Settings → Rules → Rulesets → New ruleset → New tag ruleset:

- Target: include by pattern `v*.*.*`
- Enforcement status: Active
- Rules: enable "Restrict creations" only
- Bypass list: add the bot identity confirmed in Step 1, bypass mode "Always", **plus the Repository admin role** — admins need it to hand-push hotfix tags per the runbooks in Task 7 (`prod-hotfix-during-qa.md`, `prod-emergency-hotfix.md`); without the admin bypass those runbooks would be blocked exactly during an incident

- [ ] **Step 3: Create Ruleset B — "Protect release tag immutability"**

Same target pattern `v*.*.*`, separate ruleset:

- Enforcement status: Active
- Rules: enable "Restrict deletions" + "Block force pushes"
- Bypass list: leave empty (or repo-admins-only) — deliberately excluding the bot

- [ ] **Step 4: Verify**

Attempt (as a non-bypassed, non-admin account) to push a tag matching `v*.*.*` directly — confirm it's rejected. Confirm an admin **can** create a `v*.*.*` tag (required by the hotfix runbooks). Attempt to delete an existing release tag — confirm it's rejected for everyone including the bot. This has no automated test; verify by hand and note the result here.

---

### Task 7: Runbooks and docs update

**Files:**

- Create: `docs/runbooks/deployment/prod-release-cut.md`
- Create: `docs/runbooks/deployment/prod-hotfix-during-qa.md`
- Create: `docs/runbooks/deployment/prod-emergency-hotfix.md`
- Create: `docs/runbooks/deployment/prod-rollback.md`
- Modify: `docs/calver-versioning.md`

- [ ] **Step 1: Create `docs/runbooks/deployment/prod-release-cut.md`**

```markdown
# Runbook: Cut a production release

1. Ensure `main` is in the state you want to release (or know the exact commit SHA you want, if not HEAD).
2. Run `./scripts/cut-release.sh` locally, pick the commit from the list — or trigger "Cut release" manually from the Actions tab, filling in `commit` if not releasing HEAD.
3. Confirm the tag and GitHub Release were created (Releases tab).
4. Watch the triggered `Post-merge-deploy` run: `migrate-qa` → `deploy-qa` should complete automatically.
5. Verify QA manually (smoke-test the app at the QA URL).
6. Approve the `Production-Approval` gate in the Actions run.
7. Confirm `migrate-prod` and `deploy-prod` complete.
8. Confirm `/health` on prod reflects the new version (`curl https://fluent-server-prod.../health | jq .version`).
```

- [ ] **Step 2: Create `docs/runbooks/deployment/prod-hotfix-during-qa.md`**

````markdown
# Runbook: Hotfix a bug found during QA sign-off

A release tag is currently in QA and a bug is found before prod approval.

> **Prerequisite:** hand-pushing a `v*.*.*` tag requires the Repository admin role —
> tag creation is restricted by ruleset (bot + admins only). If you aren't an admin,
> get one on the call now.

1. Fix lands on `main` via a normal PR (for the historical record).
2. Cherry-pick the fix onto a short-lived branch cut from the tag currently in QA — not from `main` HEAD, which may have unrelated merges since the tag was cut:

   ```bash
   git fetch --tags
   git checkout -b hotfix/26.07.4 v26.07.3
   git cherry-pick <fix-commit-sha>
   git push -u origin hotfix/26.07.4
   ```
````

3. `cut-release.yml` only runs against `main` today. Tag the hotfix branch tip manually, following the same `vYY.MM.N` contract cut-release.yml enforces (next serial for the current month):

   ```bash
   git tag v26.07.4
   git push origin v26.07.4
   ```

4. This triggers the same QA → approval → prod chain as a normal release.

````

- [ ] **Step 3: Create `docs/runbooks/deployment/prod-emergency-hotfix.md`**

```markdown
# Runbook: Emergency hotfix (prod broken, no pending QA cycle)

> **Prerequisite:** hand-pushing a `v*.*.*` tag requires the Repository admin role —
> tag creation is restricted by ruleset (bot + admins only).

1. Identify the tag currently live in prod (`/health` endpoint, or the latest tag that completed `deploy-prod`).
2. Branch from that tag, not from `main`:

   ```bash
   git fetch --tags
   git checkout -b hotfix/<next-tag> v<current-prod-tag>
````

3. Fix the issue on this branch.
4. Open a PR to `main` for the historical record (can land after the emergency tag, doesn't block it).
5. Tag the hotfix branch tip directly, following the `vYY.MM.N` contract:

   ```bash
   git tag v<next-tag>
   git push origin v<next-tag>
   ```

6. This still goes through QA → `Production-Approval` → prod. If the emergency genuinely can't wait for a QA cycle, that's a call for whoever holds `Production-Approval` reviewer access to make explicitly — not a path this pipeline currently automates around.

````

- [ ] **Step 4: Create `docs/runbooks/deployment/prod-rollback.md`**

```markdown
# Runbook: Roll back a production release

**Do not** re-run `Post-merge-deploy` against a prior tag — it unconditionally re-runs `migrate-prod`, which is not what a rollback wants and can be actively harmful if the release being rolled back included a schema migration.

1. Identify the prior tag to roll back to (`git tag -l 'v*' --sort=-creatordate | head -5`).
2. Before proceeding: confirm the prior tag's code is actually compatible with the **current** database schema. If the release being rolled back added a migration that's already applied, rolling back the app code without also handling the schema (e.g. a compensating down-migration) can break the app. This is a judgment call — verify, don't assume.
3. Trigger the "Deploy rollback (no migration)" workflow from the Actions tab, with `tag` set to the prior tag.
4. Confirm the deployment succeeds and `/health` reflects the rolled-back version.
5. This does **not** go through `Production-Approval` — a rollback is itself the emergency response (decided cross-repo policy, per the design spec; same as fluent-web/fluent-ai). It runs under the `Production` environment and inherits its protection rules.
````

- [ ] **Step 5: Update `docs/calver-versioning.md`**

Add a new section after the existing "Flow" description for `fluent-api`/`fluent-web` (find the numbered list ending at "The app is built and securely deployed to Azure"):

```markdown
3.5. Pushing the tag first deploys to **QA** — its own isolated Azure Web App and database. A `Production-Approval` gate then pauses the pipeline until a required reviewer approves in the Actions UI, at which point the same tag deploys to prod. No new tag is cut for the prod step; QA and prod both trace back to the one release tag.

**Picking which commit gets released:** `cut-release.yml` accepts an optional `commit` input (defaults to `main`'s tip). Use `./scripts/cut-release.sh` for an interactive picker (requires `fzf` and `gh` auth), or fill in the `commit` field manually when running the workflow from the Actions tab. Any chosen commit must already be merged to `main`.

**Rollback:** see `docs/runbooks/deployment/prod-rollback.md` — never re-run the normal deploy workflow against an old tag for this.
```

- [ ] **Step 6: Commit**

```bash
git add docs/runbooks docs/calver-versioning.md
git commit -m "docs(release): add deployment runbooks and document QA stage + commit picker"
```

---

### Task 8: Coverage threshold gate on PR checks

**Files:**

- Modify: `.github/workflows/pre-merge.yml` (and `vitest.config.ts` if thresholds are configured there rather than via CLI flags)

Per the design spec's "Test/coverage gates": enforce a coverage threshold natively via Vitest, starting at the repo's **measured current baseline** (not an arbitrary target), ratcheting up over time.

- [ ] **Step 1: Measure the current baseline**

```bash
npx vitest run --coverage 2>&1 | tail -20
```

Note the overall statements/lines percentage; round **down** to the nearest whole percent.

- [ ] **Step 2: Configure the threshold**

Prefer configuring in `vitest.config.ts` (visible to local runs too):

```ts
coverage: {
  thresholds: { lines: <measured-baseline>, statements: <measured-baseline> },
},
```

Then change the existing test step in `pre-merge.yml` to run with coverage (e.g. `npm test -- --coverage` or the repo's existing coverage script — check `package.json` scripts first and reuse rather than invent).

- [ ] **Step 3: Verify locally, run actionlint, and confirm the PR check fails when coverage drops**

Run the suite with coverage locally (should pass at the baseline). Run `actionlint .github/workflows/pre-merge.yml`. Optionally verify the gate bites: temporarily raise the threshold above the baseline, confirm the run fails, revert.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pre-merge.yml vitest.config.ts
git commit -m "feat(ci): enforce coverage threshold at measured baseline"
```

---

## Self-Review Notes

- **Spec coverage:** QA isolation ✓ (Task 3/4), commit picker ✓ (Task 1/2), rollback path ✓ (Task 5), tag governance ✓ (Task 6), runbooks ✓ (Task 7), deployment markers ✓ (Task 4), coverage gate ✓ (Task 8). Provider portability (containerization/GHCR/Fly.io) and SHA-pinning/CodeQL are explicitly deferred per the Architecture section — not gaps, deliberate scope cuts tracked as separate plans, with the accepted debt (QA jobs built on the temporary zip-deploy mechanism) stated up front.
- **Placeholder scan:** no TBDs; Task 3's Azure provisioning steps reference "mirror the existing dev/prod setup" rather than inventing fake resource-group names, since the actual values are only knowable by whoever has Azure access — this is a legitimate infra-checklist pattern, not a placeholder.
- **Type/name consistency:** `AZUREAPPSERVICE_PUBLISHPROFILE_QA`, `DATABASE_URL_QA`, and `DEPLOY_MARKER_WEBHOOK_URL` are the same secret names used consistently in Tasks 3 and 4. `fluent-server-qa` app name is consistent across Tasks 3, 4, and the runbook in Task 7.
- **Runbook/ruleset coherence:** hotfix runbooks require hand-pushed tags; Ruleset A's bypass therefore includes the Repository admin role (Task 6), and each hotfix runbook states that prerequisite up front. Rollback's skip of `Production-Approval` is decided cross-repo policy per the design spec, not a per-repo open question.
