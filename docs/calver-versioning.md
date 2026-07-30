# Fluent Calendar Versioning (CalVer)

Across the Fluent repositories, we use Calendar Versioning (CalVer) for release versioning.

## Scheme

We use the format:

```
YY.MM.SERIAL
```

- `YY` — two-digit year (e.g. `26` for 2026)
- `MM` — one or two-digit month (e.g. `7` or `11`). Note: we strip leading zeros (e.g. `7` instead of `07`) to ensure compatibility with Strict SemVer parsers (like npm).
- `SERIAL` — an auto-incrementing integer for each release within the month (e.g. `1`, `2`, `3`). It resets to `1` on the first release of a new month.

**Examples:**

- `26.7.1` (First release in July 2026)
- `26.7.2` (Second release in July 2026)
- `26.11.1` (First release in November 2026)

## Repositories

### `fluent-api` and `fluent-web` (Automated)

In these repositories, the version is automatically computed and bumped by GitHub Actions when a Production deployment is triggered manually (via `workflow_dispatch`).

**Flow:**

1. You go to GitHub Actions.
2. Select the **Post-merge-deploy** (or **Post-merge Deploy**) workflow.
3. Click "Run workflow", select the `prod` (or `production`) environment.
4. The `bump-version` job runs first:
   - Computes the next `YY.MM.SERIAL` based on Git tags.
   - Bumps `package.json` and `package-lock.json` (if present).
   - Commits `chore(release): vYY.MM.SERIAL [skip ci]`.
   - Tags the commit and pushes to `main`.
   - Creates a GitHub Release.
5. The `build` and `deploy-prod` jobs then check out this exact release tag and deploy it to Azure.

**Idempotency:**
If the `HEAD` commit is already tagged with this month's prefix (e.g. `v26.7.x`), the automation skips creating a new commit/tag and simply redeploys the existing version. This is useful for re-running failed deployments without burning a new version number.

### `fluent-ai` (Manual)

Because `fluent-ai` currently has no deployment automation, it relies on a manual process:

1. Update `version` in `pyproject.toml` to the next CalVer string.
2. Commit with `chore(release): vYY.MM.SERIAL`.
3. Tag the commit (e.g. `vYY.MM.SERIAL`) and push.

## Visibility

- **fluent-api**: The version is exposed via the `/health` endpoint.
- **fluent-web**: The version is visible on the hidden `/debug` diagnostic page.
