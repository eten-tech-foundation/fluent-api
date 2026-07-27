# CalVer Versioning + Tag-Based Deploys — Detailed Workflow Changes

See `versioning-calver-summary.md` for the problem statement and rationale. This document covers the concrete workflow file changes and the command sequence for each operational scenario.

## Tag format

```
v<YY>.<MM>.<SERIAL>
```

- `YY.MM` — two-digit year and month the release was cut, e.g. `26.07`.
- `SERIAL` — 1-indexed count of releases cut in that year/month, reset implicitly each month. Not stored in any file; derived by scanning existing tags matching `v<YY>.<MM>.*` and incrementing the highest found.

Examples: `v26.07.1`, `v26.07.2`, ... `v26.08.1` (resets in August).

## 1. New workflow: `cut-release.yml`

Add `.github/workflows/cut-release.yml`. Manually triggered — this is the "start a QA cycle" button.

```yaml
name: Cut release
on:
  workflow_dispatch: {}

jobs:
  tag:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0 # need full tag history to compute the next serial

      - name: Compute CalVer tag
        id: version
        run: |
          YEAR_MONTH=$(date +'%y.%m')
          SERIAL=$(git tag -l "v${YEAR_MONTH}.*" | sed -E "s/^v${YEAR_MONTH}\.//" | sort -n | tail -1)
          SERIAL=${SERIAL:-0}
          NEXT=$((SERIAL + 1))
          TAG="v${YEAR_MONTH}.${NEXT}"
          echo "tag=$TAG" >> "$GITHUB_OUTPUT"
          echo "Computed tag: $TAG"

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

Pushing the tag triggers `post-merge-deploy.yml`'s prod path (see below) via the `tags:` push trigger.

## 2. Change: `post-merge-deploy.yml` triggers

Current trigger:

```yaml
on:
  push:
    branches:
      - main
  workflow_dispatch:
    inputs:
      environment:
        description: Environment to deploy to
        required: true
        default: dev
        type: choice
        options:
          - dev
          - prod
```

New trigger:

```yaml
on:
  push:
    branches:
      - main # dev deploy path — unchanged behavior
    tags:
      - 'v*.*.*' # prod deploy path — replaces workflow_dispatch
```

Remove the `workflow_dispatch` environment input entirely — prod deploys should never be dispatchable against an arbitrary `main` HEAD. `dev` continues to deploy automatically on every merge, same as today.

### Job condition changes

`migrate-dev` / `deploy-dev` — condition changes from:

```yaml
if: github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && github.event.inputs.environment == 'dev')
```

to:

```yaml
if: github.ref_type == 'branch'
```

`migrate-prod` / `deploy-prod` — condition changes from:

```yaml
if: github.event_name == 'workflow_dispatch' && github.event.inputs.environment == 'prod'
```

to:

```yaml
if: github.ref_type == 'tag'
```

## 3. Change: stamp `package.json` version from the tag

Add to the `build` job in `post-merge-deploy.yml`, after dependency install and before the build step, guarded to only run on tag builds:

```yaml
- name: Set version from tag
  if: github.ref_type == 'tag'
  run: npm version ${{ github.ref_name }} --no-git-tag-version --allow-same-version
```

This makes the deployed artifact self-reporting (e.g. via a `/health` endpoint or startup log line), which matters when debugging which release is actually live in prod.

## 4. Scenario walkthroughs

### Scenario A: normal release, no issues found in QA

```bash
# 1. Team merges PRs to main as usual throughout the sprint — no change to this flow.

# 2. When ready to start a QA cycle, trigger the release cut:
gh workflow run cut-release.yml

# 3. Workflow computes and pushes a tag, e.g.:
#    Computed tag: v26.07.3
# This automatically triggers the prod path in post-merge-deploy.yml,
# which deploys v26.07.3 to the QA/staging slot for verification.
# (If QA runs against a separate pre-prod environment, add a `migrate-qa`/`deploy-qa`
# job gated the same way as prod but pointed at the QA app; omitted here for brevity.)

# 4. Meanwhile, engineers keep merging PRs to main — main moves forward,
# the v26.07.3 tag does not. Nothing merged after this point is part of this release.

# 5. QA signs off. Promote the already-tagged, already-built artifact to prod.
# If prod deploy is a separate approval gate (GitHub Environment protection rule),
# approve the pending deployment in the Actions UI or via:
gh run list --workflow=post-merge-deploy.yml --limit 1
gh run view <run-id>   # approve the Production environment gate here
```

### Scenario B: bug found during QA, fix needed before prod

```bash
# 1. Fix is developed and merged to main as a completely normal PR.
git checkout -b fix/qa-bug-123 main
# ...make the fix...
git push -u origin fix/qa-bug-123
gh pr create --base main --title "Fix: QA bug 123"
# ...PR reviewed and merged to main via the normal pre-merge.yml gate...

# 2. Cherry-pick just that fix commit onto a short-lived branch based on the
# tag that's currently in QA (do NOT branch from main HEAD — main may have
# other unrelated work merged since the tag was cut):
git fetch --tags
git checkout -b hotfix/26.07.4 v26.07.3
git cherry-pick <fix-commit-sha>
git push -u origin hotfix/26.07.4

# 3. Cut the next release tag from this branch instead of from main:
git tag v26.07.4
git push origin v26.07.4
# This triggers the same prod-path deploy as Scenario A, but for v26.07.4.

# 4. QA re-verifies (ideally just the delta). Once signed off, promote to
# prod the same way as step 5 in Scenario A.

# 5. Housekeeping: merge the hotfix branch back into main if the cherry-pick
# commit needs any adjustment there (usually a no-op since it already merged
# to main in step 1):
git checkout main
git pull
git branch -d hotfix/26.07.4   # local cleanup; delete remote branch too if desired
git push origin --delete hotfix/26.07.4
```

### Scenario C: emergency hotfix directly to prod, no pending QA cycle

```bash
# 1. Identify the tag currently running in prod:
gh release list --limit 1

# 2. Branch from that exact tag (not main — main will have unrelated commits):
git fetch --tags
git checkout -b hotfix/26.07.5 v26.07.4
# ...make the minimal fix...
git push -u origin hotfix/26.07.5

# 3. Open a PR to main so the fix goes through the normal review/lint/test gate
# in pre-merge.yml, then merge it. This keeps main as the source of truth for
# the fix even though the tag will be cut from the hotfix branch, not main.
gh pr create --base main --title "Hotfix: <description>"

# 4. Tag directly from the hotfix branch tip (don't wait for a full release cut):
git tag v26.07.5
git push origin v26.07.5
# Deploys straight to prod via the tag-push trigger.
```

## 5. Rollback

Because prod only ever deploys a tagged, immutable commit, rollback is re-running deploy against the previous tag:

```bash
git checkout v26.07.3
# Re-trigger the prod deploy job for this ref, e.g. by re-running the
# workflow run associated with that tag:
gh run list --workflow=post-merge-deploy.yml
gh run rerun <previous-run-id>
```

No branch surgery required — the previous artifact is exactly reproducible from the tag.

## 6. Open questions to resolve before implementing

- Does QA run against a distinct environment from `dev`, or does the tag deploy straight to a `staging` slot? If a dedicated QA/staging environment is needed, a `migrate-qa`/`deploy-qa` job pair should be added to `post-merge-deploy.yml`, gated the same way as prod (`github.ref_type == 'tag'`) but targeting the QA app service. - **Answer:** Yes, a dedicated QA/staging environment is needed and planned to be implemented soon.
- Should prod deploy require a GitHub Environment manual-approval gate (recommended), or should tag push deploy straight to prod once QA has separately signed off out-of-band? - **Answer:** Yes, a manual approval gate is recommended.
- `SERIAL` reset is implicit (derived from tag scan) — confirm this is acceptable vs. wanting an explicit release counter stored in a file (e.g. `VERSION`). - **Answer:** Yes, this is acceptable.
