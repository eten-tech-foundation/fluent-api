# Fluent Calendar Versioning (CalVer)

Across the Fluent repositories, we use Calendar Versioning (CalVer) for release versioning.

## Scheme

We use the strict format:

```text
YY.MM.SERIAL
```

- `YY` — two-digit year (e.g. `26` for 2026)
- `MM` — two-digit month (e.g. `07` or `11`). We enforce leading zeros for consistency.
- `SERIAL` — an auto-incrementing integer for each release within the month (e.g. `1`, `2`, `3`). It resets to `1` on the first release of a new month.

**Examples:**

- `26.07.1` (First release in July 2026)
- `26.07.2` (Second release in July 2026)
- `26.11.1` (First release in November 2026)

## Repositories

### `fluent-api` and `fluent-web` (Automated)

In these repositories, production deployments are strictly **Tag-Based**.

**Flow:**

1. You go to GitHub Actions and manually trigger the **Cut release** workflow on the `main` branch.
2. The workflow automatically calculates the next `vYY.MM.SERIAL` tag (with leading zeros), tags the commit, and pushes the tag to GitHub.
3. Pushing the `v*.*.*` tag automatically triggers the **Post-merge Deploy** workflow.
4. The deployment runner checks out the exact tag.
5. To inject the version into the build without crashing Strict SemVer parsers (like `npm`), the CI pipeline dynamically parses the configuration using tools like `jq` or env vars (`VITE_APP_VERSION`), completely bypassing `npm version`.
6. The app is built and securely deployed to Azure. (`fluent-web` enforces `--frozen-lockfile` for reproducible rollbacks.)

### `fluent-ai` (Manual)

Because `fluent-ai` currently has no deployment automation, it relies on a manual process for versioning and tagging.

**Note for Python:** Python's PEP-440 versioning standard automatically strips leading zeros. While the global spec is `26.07.1`, Python will natively format it as `26.7.1` in `pyproject.toml`. This is expected behavior.

### How to release a new version in `fluent-ai`

1. Update `version` in `pyproject.toml` to the next CalVer string (e.g., `26.7.1`).
2. Commit with `chore(release): vYY.MM.SERIAL`.
3. Tag the commit (e.g. `vYY.MM.SERIAL`) and push.

## Visibility

- **fluent-api**: The version is exposed via the `/health` endpoint.
- **fluent-web**: The version is visible in the UI diagnostic footer.
