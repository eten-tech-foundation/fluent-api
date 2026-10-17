---
name: pre-pr-standards
description: Check a fluent-api branch against docs/guides/code-standards.md. Use before opening a PR or marking one ready for review, and when reviewing a fluent-api diff for standards.
---

# Pre-PR standards check

The rules and their IDs live in `docs/guides/code-standards.md`; read it first. This skill is
the procedure for applying them to a branch.

1. **Verify.** Run `npm run verify`. Done when it exits 0. Fix each `FA-L*`/`FA-C*` failure
   in the code, using the doc's table. The baselines (`eslint-suppressions.json`,
   `knip-baseline.json`) only ever shrink: after fixing a grandfathered violation run
   `npm run lint:prune` or `npm run deadcode -- --update`, and never regenerate them to
   absorb a new one.
2. **Collect the diff.** `git diff origin/main...HEAD` plus uncommitted and untracked files.
   Done when you have the full list of changed files.
3. **Audit every FA-R rule.** For each rule `FA-R1`…`FA-R12`, record a verdict against the
   diff: `ok`, `n/a`, or `violation` with `file:line` evidence. FA-R1 means searching the
   codebase for an existing helper, schema or constant for each new one the diff adds;
   FA-R3 means reading the OpenAPI descriptions, test titles and docs that touch the changed
   behavior. Done when every rule has a verdict backed by something you read.
4. **Fix and re-verify.** Fix each violation, then rerun step 1.
5. **Report.** Return the verdict table. Any violation left in place on purpose goes in the
   PR body under **Standards exceptions**, with its ID and the reason.
