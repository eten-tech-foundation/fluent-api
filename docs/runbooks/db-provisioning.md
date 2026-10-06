# DB Provisioning (Dev / QA)

Quick "how do I actually run this" guide for the dev/qa DB scripts.
For the full role/schema/grant reference, see
[`db-provisioning-and-setup.md`](../db-provisioning-and-setup.md).

## The scripts, in order

```text
1. provision-db.ts                → one-time-ish, superuser, idempotent
   (npm run db:provision:<env>)      Creates/reconciles roles, schemas, grants.

2. setup.ts                       → every deploy / data reset
   (npm run db:setup:<env>)          Runs Drizzle migrations, then seeds.

3. reset-db.ts                    → manual clean-slate reset, confirm-gated
   (npm run db:reset:<env>)          Drops public/drizzle/pgboss, recreates,
                                    then runs script 2 unchanged. Never
                                    touches the ai schema.

4. cleanup-legacy-provisioning.ts → one-time, run manually, one-way
   (no npm script — run directly)   Drops the legacy pre-separation roles.
```

Only #2 runs automatically (as part of deploy). The others are run by hand,
against a specific environment, when that environment's roles or data need
to change.

## 1. `provision-db.ts`

**Assumes:** nothing pre-existing — safe to run on a fresh database or
re-run any number of times on one that already has the correct roles.

**Minimum env vars:**

```sh
BOOTSTRAP_DATABASE_URL=postgres://<superuser>:<pw>@<host>:5432/<db>?sslmode=require
API_MIGRATOR_PASSWORD=...
API_USER_PASSWORD=...
AI_MIGRATOR_PASSWORD=...
AI_USER_PASSWORD=...
```

**Run:**

```sh
npm run db:provision:dev   # or db:provision:qa
```

**Expect:** `DB provisioning complete ✓`. If a previous run left legacy
roles (`db_admin`, `migrations`, `web_user`, `role_*`) in place, this script
does not touch them — it only creates/reconciles `api_migrator`, `api_user`,
`ai_migrator`, `ai_user` and reassigns object ownership to them. Legacy
roles are removed separately, by script #3.

**Verify (no `psql` needed — the `postgres` npm package already in
`node_modules` works from a throwaway `tsx` script):**

- Connect directly as `ai_user` (not `SET ROLE` — the bootstrap superuser
  has no membership in `ai_user`, so `SET ROLE ai_user` fails on its own)
  and query any `public` table → expect `permission denied` (42501).
- Same, connecting as `api_user`, querying any `ai` table → expect
  `permission denied for schema ai`.
- Both should still succeed reading their own schema.

## 2. `setup.ts`

**Assumes:** `provision-db.ts` has already run successfully against this
environment — `setup.ts` runs migrations as `api_migrator` (via
`MIGRATIONS_DATABASE_URL`) and seeds as `api_user`, neither of which exist
otherwise.

**Minimum env vars (dev shown; qa is the same shape with `QA_` prefixes):**

```sh
DEV_DATABASE_URL=postgres://api_user:<pw>@<host>:5432/<db>?sslmode=require
MIGRATIONS_DATABASE_URL=postgres://api_migrator:<pw>@<host>:5432/<db>?sslmode=require
DEV_PM_EMAIL=...
DEV_PM_PASSWORD=...
DEV_SEED_PASSWORD=...
```

`MIGRATIONS_DATABASE_URL` has no `DEV_`/`QA_`-prefixed variant — it's the
same variable for every environment (same pattern as
`BOOTSTRAP_DATABASE_URL`).

**Run:**

```sh
npm run db:setup:dev   # or db:setup:qa
```

**Note:** this writes real seed data (org, roles, RBAC, seed users, bible
reference data) to whatever database `DEV_DATABASE_URL`/`QA_DATABASE_URL`
points at. Don't run it against a shared dev/qa instance without expecting
that data to land there.

If you only need to confirm migrations apply cleanly without seeding,
`npm run db:migrate` alone uses the same `MIGRATIONS_DATABASE_URL` and is
idempotent.

QA takes no `DEV_*` credential vars — every QA account uses one shared
committed hash (`QA_DEMO_PASSWORD_HASH` in `src/db/seeds/demo/qa-spec.ts`),
so `QA_DATABASE_URL` + `MIGRATIONS_DATABASE_URL` are the whole env.

## 3. `reset-db.ts`

**Assumes:** `provision-db.ts` has already run — and specifically that it
has run _since_ it gained `GRANT api_user TO api_migrator` (the DDL role
needs membership in `api_user` to drop the `api_user`-owned `pgboss`
schema). Databases provisioned before that change need
`npm run db:provision:<env>` re-run once first.

**Minimum env vars:** `MIGRATIONS_DATABASE_URL` for the drop/recreate and
migrations, plus the usual runtime URL (`DEV_DATABASE_URL` /
`QA_DATABASE_URL`) for the seed stage it delegates to `setup.ts`.

**Run:**

```sh
SETUP_ENV=qa npm run db:reset:qa    # or db:reset:dev
```

`SETUP_ENV` must be `dev` or `qa` — the script refuses `local` and points
at `docker compose down -v` instead. It prints the masked target URL +
database name and proceeds only when you type the exact database name;
there is no `--yes`/`--force` flag. It drops `public`, `drizzle`, and
`pgboss` with `CASCADE` (the `ai` schema is never touched), recreates
`public` (owner `api_migrator`) and `pgboss` (owner `api_user`), restores
the `api_migrator → api_user` default privileges that the drop destroys,
then runs `setup.ts` — migrations + all seeds, unchanged.

## 4. `cleanup-legacy-provisioning.ts`

**Assumes, and checks before doing anything:** `provision-db.ts` has
already run and reassigned every legacy-owned object — schemas, tables,
sequences, views, materialized views, enum types, and functions/procedures
in `public`/`ai`/`drizzle`/`pgboss` — away from `db_admin`, `migrations`,
and `web_user`. It also assumes nothing still authenticates as those roles
or as the group roles (`role_web_data`, `role_ai_data`, `role_ai_reader`,
`role_pgboss_user`, `role_migrations`) — app config must already be cut
over to the new role names first.

**Minimum env vars:** just `BOOTSTRAP_DATABASE_URL` (same superuser
connection as `provision-db.ts`).

**Run (no npm script — intentional, so it's never run by accident):**

```sh
SETUP_ENV=dev npx tsx src/db/scripts/cleanup-legacy-provisioning.ts
# or SETUP_ENV=qa
```

**Expect:** a precondition report, then each legacy role dropped one at a
time. If the precondition check fails, it exits before dropping anything —
that means `provision-db.ts` hasn't fully reassigned ownership yet in this
environment; re-run #1 first. If a `DROP OWNED BY` fails partway through,
that means something not yet reassigned still depends on that role —
investigate the named dependency; don't add `CASCADE` to force past it.

**This is not idempotent in the usual sense:** re-running it after the
legacy roles are already gone is harmless (it reports each one "already
dropped" and exits cleanly), but it is a one-way operation — there's no
script to recreate `db_admin`/`migrations`/`web_user` if something turns
out to still need them.

## Order matters

Always: `provision-db.ts` → (app cutover to new role names) →
`cleanup-legacy-provisioning.ts`. Running cleanup before cutover risks
dropping a role a running service still connects as. `reset-db.ts` can run
any time after provisioning — it leaves roles alone and only rebuilds the
application schemas.
