# Production Rollback

If you need to roll back production to a previous version, **do not just re-run the `post-merge-deploy.yml` workflow against an old tag**.

Re-running the workflow unconditionally runs the `migrate-prod` step, which will attempt to run database migrations. If the bad release included database schema changes, simply deploying the old application code against the new schema will likely cause errors.

### To Rollback Safely:

1. **Verify Database Compatibility:** Determine if the bad release included any database migrations. If it did, you must either write a downward migration (and deploy forward) or manually intervene in the database.
2. If there are no schema changes or downward migrations are safe, the recommended way to roll back is to deploy forward. Cut a hotfix (see `prod-emergency-hotfix.md`) that reverts the bad commit, and push a new tag.
3. If you must deploy the exact old artifact manually, use Azure Portal to swap to a previous deployment slot (if configured) or download the old artifact and deploy it directly via Azure CLI.
