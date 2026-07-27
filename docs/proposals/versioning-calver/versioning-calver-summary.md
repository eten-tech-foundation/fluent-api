# CalVer Versioning + Tag-Based Deploys — Summary

## Problem

`main` is the default branch. Merging a PR deploys to **dev** automatically; deploying to **prod** is a manual `workflow_dispatch` that runs against whatever commit is on `main` HEAD at the moment someone clicks the button.

This means: once a release enters its QA cycle, any PR that merges to `main` before prod deploy happens is either (a) silently swept into the prod deploy along with it, unQA'd, or (b) blocks the team from merging anything until prod deploy is done. Neither is acceptable — teams need to keep merging without being gated by someone else's QA cycle.

A `develop`-as-default-branch alternative was considered and rejected: it introduces a second long-lived branch that drifts from `main`, requiring a manual "merge main back into develop" step after every hotfix that's easy to forget and creates the exact "develop is behind by one commit" problem it was meant to avoid.

## Recommendation: tag-based deploys

Keep `main` as the single trunk everyone merges into continuously — no new long-lived branch. Instead of prod deploying from whatever `main` HEAD happens to be, prod deploys from an explicit, immutable **git tag** cut on demand. The tag is the thing QA verifies; it doesn't move if someone merges to `main` afterward.

This is the smallest possible change to the existing pipeline shape (`.github/workflows/post-merge-deploy.yml` already separates dev/prod deploy jobs) and gives us CalVer versioning for free, since the tag name _is_ the version.

## CalVer format

`YY.MM.SERIAL` — e.g. `26.07.3` is the 3rd release cut in July 2026. `SERIAL` resets implicitly each month (it's derived by scanning existing tags for that `YY.MM` prefix, not stored anywhere separately).

## What changes

| Component                      | Change                                                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-merge.yml`                | No change. Still gates every PR into `main`.                                                                                                                                                                            |
| `post-merge-deploy.yml`        | Dev deploy still triggers on push to `main` (unchanged). Prod deploy trigger switches from manual `workflow_dispatch` to `push: tags: 'v*.*.*'` — prod can now _only_ deploy a tagged commit, never a bare `main` HEAD. |
| New `cut-release.yml` workflow | Manually triggered when a team is ready to start a QA cycle. Computes the next `YY.MM.SERIAL` tag from existing tags and pushes it — this is the one new step in the process.                                           |
| `package.json` version         | Stamped from the tag at build time instead of hand-maintained, so the deployed artifact can report its own version.                                                                                                     |

## How this solves the blocking problem

- Engineers keep merging PRs to `main` at any time — merging is never gated by an in-flight QA cycle.
- QA tests a tag (an immutable snapshot), not a moving branch, so nothing merged after the tag was cut can leak into that release.
- If QA finds a bug: the fix lands on `main` as a normal PR, gets cherry-picked onto a short-lived branch cut from the QA'd tag, and a new tag (`SERIAL` bumped) is cut for re-verification. No second long-lived branch, no drift bookkeeping.

See `versioning-calver-workflows.md` for the detailed workflow definitions and step-by-step command sequences for each scenario.
