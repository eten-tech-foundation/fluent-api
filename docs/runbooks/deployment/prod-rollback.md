# Production Rollback

Rolling back is a **Promote to Production** run against the previous tag. That
workflow exists for this: it checks the old tag out by commit, rebuilds it, and
verifies `/health` reports the version you asked for.

> [!IMPORTANT]
> Rolling back the code does **not** roll back the schema. `npm run db:migrate`
> applies pending migrations; it never removes applied ones. Deploying an older
> tag is a no-op for the database and leaves the newer schema in place, with
> older code running against it.

## Before you roll back

Determine whether the bad release included a migration:

```bash
# Example: git diff --stat v26.07.1..v26.07.2 -- src/db/migrations
git diff --stat <GOOD_TAG>..<BAD_TAG> -- src/db/migrations
```

- **No migrations.** Roll back directly, below.
- **Additive migrations** (new nullable column, new table). Usually safe: the
  old code ignores what it doesn't know about. Roll back, then plan the schema
  cleanup separately.
- **Destructive or incompatible migrations** (dropped or renamed column,
  tightened constraint, changed type). **Do not roll back.** The old code will
  fail against the new schema. Roll forward instead: cut a hotfix that reverts
  the bad commit (see [`prod-emergency-hotfix.md`](prod-emergency-hotfix.md)),
  or write a compensating migration.

## To roll back

1. Identify the last good tag:
   ```bash
   git tag -l "v*" | sort -V | tail -5
   ```
2. Run **Promote to Production** with that tag. It already has a successful QA
   deployment from when it was first released, so the QA check passes and
   `skip_qa_check` is not needed.
3. Approve the `Production` environment gate.
4. Verify:
   ```bash
   curl -s https://fluent-server-prod.azurewebsites.net/health | jq .version
   ```
5. Open a follow-up to fix forward. A rollback leaves `main` ahead of
   production, and the next release cut will ship the bad commit again unless
   it is reverted.
