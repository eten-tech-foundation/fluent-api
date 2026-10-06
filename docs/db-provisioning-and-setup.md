# Database Infrastructure Setup & Data Seeding Guide

> **Target Component:** `fluent-api`  
> **Document Status:** Active / Production Reference  
> **Target Environments:** Local Docker, Dev (Azure PostgreSQL), QA / Staging (Azure PostgreSQL)

---

## 💡 What is DB Provisioning vs. Data Seeding?

To keep our database secure and maintainable across environments, database tasks are split into two distinct steps:

```text
1. Infrastructure Setup (provision-db.ts)
   └── Run ONCE per fresh Database Host
       ├── Create DB Roles & Accounts: api_user, ai_user, api_migrator, ai_migrator
       └── Create Schemas & Set Default Permissions
            │
            ▼
2. Data Seeding & Migrations (setup.ts)
   └── Run whenever resetting data or deploying
       ├── Run Drizzle Table Migrations
       ├── Seed System Data: Org, Roles, RBAC
       └── Seed Demo Spec: Orgs, Users, Projects & Grants
```

- **Database Provisioning (`provision-db.ts`)** = **Setting up DB Server Rules & Security.**
  - Think of this like setting up the doors, locks, and permissions on a new database server host.
  - Creates database logins (`api_user`, `ai_user`, `api_migrator`, `ai_migrator`), schemas (`public`, `ai`, `drizzle`, `pgboss`), and security privileges.
  - Executed **once** when initializing a fresh cloud database instance (e.g. Azure PostgreSQL Flexible Server).

- **Data Seeding & Setup (`setup.ts`)** = **Populating Tables & Initial Data.**
  - Think of this like populating data into the database.
  - Runs schema migrations (creating/updating tables) and seeds reference data: organization, roles, system users, languages, books, Bibles, and pericopes.
  - Executed when initializing application data or resetting development environments.

---

## 🔑 Environment Variable Configuration

### Where to Set Environment Variables

You can configure database URLs and credentials in three places — listed in **precedence order** (highest first):

1. **Shell / CI / Azure App Config (Real Environment Variables)**: Variables set in the process environment, GitHub Secrets, or Azure App Service Configuration. These always win — `dotenv` never overwrites them.
2. **Local `.env` File**: Place variables in `.env` at the root of `fluent-api`. Both `provision-db.ts` and `setup.ts` load this file via `dotenv/config` at startup. Useful for local development runs.
3. **Inline CLI Flag (One-off Execution)**: Pass variables directly in your terminal command — these become real env vars for that process, so they also take precedence over `.env`.

> **Precedence rule:** Shell env vars > `.env` file. If `BOOTSTRAP_DATABASE_URL` is already set in your shell, the `.env` value is silently ignored. This means CI and Azure deployments are never affected by a developer's local `.env`.

### Environment Variable Catalog

| Variable Name             | Required By         | Description / Format                                                                                                                                                                                                                                 | Example Value                                              |
| ------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`            | `setup.ts` (local)  | Runtime role URL injected by docker-compose for local. Last-resort fallback for dev/qa.                                                                                                                                                              | `postgres://api_user:pass@localhost:5432/fluentdb`         |
| `MIGRATIONS_DATABASE_URL` | `drizzle.config.ts` | Direct DDL migration connection URL, read directly by drizzle-kit — same variable for every environment (local, dev, qa). No `DEV_`/`QA_` prefixed variant; set this one directly wherever it's needed, the same way `BOOTSTRAP_DATABASE_URL` works. | `postgres://api_migrator:pass@dev-host:5432/fluentdb`      |
| `DEV_DATABASE_URL`        | `setup.ts` (dev)    | Runtime role URL for dev — **wins over** `DATABASE_URL` when `SETUP_ENV=dev`.                                                                                                                                                                        | `postgres://api_user:pass@dev-host:5432/fluentdb`          |
| `QA_DATABASE_URL`         | `setup.ts` (qa)     | Runtime role URL for QA — **wins over** `DATABASE_URL` when `SETUP_ENV=qa`.                                                                                                                                                                          | `postgres://api_user:pass@qa-host:5432/fluentdb`           |
| `BOOTSTRAP_DATABASE_URL`  | `provision-db.ts`   | Superuser / Admin URL to create roles & schemas                                                                                                                                                                                                      | `postgres://admin:pass@host:5432/fluentdb?sslmode=require` |
| `API_MIGRATOR_PASSWORD`   | `provision-db.ts`   | Password for the schema-owner `api_migrator` role                                                                                                                                                                                                    | `SecretApiMigratorPass123`                                 |
| `API_USER_PASSWORD`       | `provision-db.ts`   | Password for the API runtime `api_user` account                                                                                                                                                                                                      | `SecretApiUserPass123`                                     |
| `AI_MIGRATOR_PASSWORD`    | `provision-db.ts`   | Password for the AI schema-owner `ai_migrator` role                                                                                                                                                                                                  | `SecretAiMigratorPass123`                                  |
| `AI_USER_PASSWORD`        | `provision-db.ts`   | Password for the AI service `ai_user` account                                                                                                                                                                                                        | `SecretAiUserPass123`                                      |
| `DEV_PM_EMAIL`            | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it.                                                                                                                                                        | `pm@yourorg.com`                                           |
| `DEV_PM_PASSWORD`         | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it.                                                                                                                                                        | `StrongPassword!1`                                         |
| `DEV_SEED_PASSWORD`       | `setup.ts` (dev)    | Shared password for the 3 translator accounts (`alice.smith`, `bob.johnson`, `carol.davis`).                                                                                                                                                         | `StrongPassword!2`                                         |

> **URL resolution order for `db:setup:dev`:**
> `DEV_DATABASE_URL` → `DATABASE_URL` (last resort) for the runtime connection.
> `MIGRATIONS_DATABASE_URL`, if set, is passed straight through to
> `drizzle-kit migrate` so it runs as the DDL-capable `api_migrator` role
> rather than `api_user` — this is the same variable in every environment,
> per `drizzle.config.ts`'s `MIGRATIONS_DATABASE_URL ?? DATABASE_URL`.

> **QA needs no credential variables.** Every QA account authenticates with
> one shared demo password committed as a better-auth hash —
> `QA_DEMO_PASSWORD_HASH` in `src/db/seeds/demo/qa-spec.ts`. The hash is
> generated once, locally, via `npm run db:hash-password "<password>"` and
> committed to the spec; the plaintext never lives in the repo, in `.env`
> files, or in CI variables. To rotate: regenerate the hash and commit the
> new value (the engine reconciles stored hashes on the next seed). Dev
> takes the middle path — no committed hash, but passwords via
> `DEV_PM_PASSWORD`/`DEV_SEED_PASSWORD` env vars rather than hardcoding.

---

## 📂 Component & File Inventory (20 Files)

The database provisioning and environment-aware seeding system consists of 20 key files across `fluent-api`, organized by role:

### 1. Environment Configurations (`src/db/env-configs/`)

| File Path                     | Status  | Environment       | Configured Seed Data                                                                                                                                                               |
| ----------------------------- | ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/env-configs/local.ts` | `[NEW]` | Local Docker      | `demoSpec` with 3 committed-credential users (`devpm`, `translator`, `translator2`).                                                                                               |
| `src/db/env-configs/dev.ts`   | `[NEW]` | Shared Dev Server | `demoSpec` — `Fluent Dev` org. PM via `DEV_PM_EMAIL`/`DEV_PM_PASSWORD`. Translators (`alice.smith`, `bob.johnson`, `carol.davis`) via `DEV_SEED_PASSWORD`. No hardcoded passwords. |
| `src/db/env-configs/qa.ts`    | `[NEW]` | QA / Staging      | `demoSpec: qaSpec` — the full QA demo world (4 orgs, 17 users, 3 projects). All accounts share one committed-hash password.                                                        |

### 2. Core Scripts & Shared Types

| File Path                                       | Status       | Purpose & Usage                                                                                                                                                                              |
| ----------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/env-configs/types.ts`                   | `[NEW]`      | TypeScript interfaces defining `EnvConfig` (including its `demoSpec` slot) and `DbProvisionConfig`.                                                                                          |
| `src/db/env-configs/database-url.ts`            | `[NEW]`      | Shared URL helpers: `applyDatabaseUrl`, `maskDatabaseUrl`, `databaseNameFromUrl`.                                                                                                            |
| `src/db/scripts/provision-db.ts`                | `[NEW]`      | One-time superuser DDL script for database role creation, user reconciles, schema creation, and default privileges.                                                                          |
| `src/db/scripts/reset-db.ts`                    | `[NEW]`      | Confirm-gated clean-slate reset for dev/qa — drops `public`/`drizzle`/`pgboss`, recreates, delegates to `setup.ts`.                                                                          |
| `src/db/scripts/hash-password.ts`               | `[NEW]`      | Prints a better-auth password hash for committed seed credentials.                                                                                                                           |
| `src/db/scripts/bootstrap.ts`                   | `[NEW]`      | Creates the four roles/schemas on the local Docker path (the container entrypoint's equivalent of `provision-db.ts`).                                                                        |
| `src/db/scripts/cleanup-legacy-provisioning.ts` | `[NEW]`      | One-time, one-way drop of the legacy pre-separation roles after `provision-db.ts` reassigns ownership — see `docs/runbooks/db-provisioning.md`.                                              |
| `src/db/scripts/sql-helpers.ts`                 | `[NEW]`      | Shared `quote_ident`/`quote_literal` helpers used by the DDL scripts.                                                                                                                        |
| `src/db/scripts/setup.ts`                       | `[MODIFIED]` | Environment-aware setup orchestrator (`SETUP_ENV=local/dev/qa`), dynamic `DATABASE_URL` resolution, and Drizzle migration runner.                                                            |
| `src/db/seeds/demo/`                            | `[NEW]`      | Declarative demo-seed engine (`seedDemoSpec`) plus per-env specs (`qa-spec.ts`, `dev-spec.ts`) — reconciles orgs, users, grants, projects, milestones, and chapter assignments idempotently. |
| `src/db/seeds/dev-users.ts`                     | `[MODIFIED]` | Shared `reconcileSeedUser` writer used by the demo seed engine (plaintext or committed-hash credentials).                                                                                    |
| `src/db/seeds/organizations.ts`                 | `[MODIFIED]` | Parameterized organization seeding accepting custom org names per environment.                                                                                                               |

### 3. Documentation

| File Path                           | Status       | Purpose & Usage                                                   |
| ----------------------------------- | ------------ | ----------------------------------------------------------------- |
| `docs/db-provisioning-and-setup.md` | `[NEW]`      | Comprehensive architecture and operational reference guide.       |
| `README.md`                         | `[MODIFIED]` | Linked database setup documentation in the main repository index. |

### 4. Infrastructure & Project Configurations

| File Path              | Status       | Purpose & Usage                                                                                                                                                  |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`         | `[MODIFIED]` | Added CLI scripts (`db:setup:*`, `db:reset:*`, `db:provision:*`, `db:seed*`, `db:hash-password`).                                                                |
| `docker-entrypoint.sh` | `[MODIFIED]` | Configured local Docker container startup to set `SETUP_ENV=local`.                                                                                              |
| `src/lib/queue.ts`     | `[MODIFIED]` | `createSchema: false` — pgboss schema is pre-created by `provision-db.ts` / `bootstrap.ts` as a superuser, so the runtime role never needs `CREATE ON DATABASE`. |

---

## 🔒 1. Database Role & Security Hierarchy (`provision-db.ts`)

`provision-db.ts` enforces **least-privilege security**. Access is partitioned into distinct Login Accounts for each service.

### Login Users & Schemas

| Login Account  | Type     | Target Schemas / Privileges                    |
| -------------- | -------- | ---------------------------------------------- |
| `api_migrator` | Migrator | DDL/Owner: `public` and `drizzle`              |
| `api_user`     | Runtime  | DML on `public` and `drizzle`; Owner: `pgboss` |
| `ai_migrator`  | Migrator | DDL/Owner: `ai`                                |
| `ai_user`      | Runtime  | DML on `ai` only (No cross-schema read)        |

> **pgboss schema:** Owned by `api_user` (not `api_migrator`) so pg-boss can create its own tables,
> enums, and functions at runtime without needing `CREATE ON DATABASE`. This mirrors how
> `bootstrap.ts` sets it up for local Docker (`CREATE SCHEMA pgboss AUTHORIZATION api_user`).

---

## ⚙️ 2. Environment Setup & Connection Resolution (`setup.ts`)

`setup.ts` orchestrates running Drizzle ORM migrations and seeding data according to the target environment specified by `SETUP_ENV`.

### Target Environments

| `SETUP_ENV` | Config File                   | Usage             | Seed Strategy                                                                                                                                                             |
| ----------- | ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`     | `src/db/env-configs/local.ts` | Local Docker      | `devSpec` with committed plaintext defaults — 3 users (`devpm`, `translator`, `translator2`) on one GEN+EXO project                                                       |
| `dev`       | `src/db/env-configs/dev.ts`   | Shared Dev Server | `devSpec` with env-var credentials — PM (`DEV_PM_EMAIL`) + 3 translators (`alice.smith`, `bob.johnson`, `carol.davis`) via `DEV_SEED_PASSWORD`. No hardcoded credentials. |
| `qa`        | `src/db/env-configs/qa.ts`    | Staging / QA      | `qaSpec` — full demo world: 4 orgs, 17 users, 3 projects / 4 milestones. One shared committed-hash password for every account.                                            |

### 👥 Seeded User Accounts

Every environment's users come from its `demoSpec`, reconciled idempotently
by the demo seed engine. Project roles are **project-scoped** (PM /
Translator / Observer carry `project_id`); every user also gets an
`Org Member` anchor grant per org membership.

#### Local (`SETUP_ENV=local`)

Committed plaintext defaults — local Docker only, never reused elsewhere.

| Username      | Email           | Password    | Role Grants                                        |
| ------------- | --------------- | ----------- | -------------------------------------------------- |
| `devpm`       | pm@fluent.local | `pm@123456` | Project Manager (Gujarati → English — GEN & EXO)   |
| `translator`  | t@fluent.local  | `t@123456`  | Project Translator (same project); peer-check pair |
| `translator2` | t2@fluent.local | `t@123456`  | Project Translator (same project); peer-check pair |

#### Dev (`SETUP_ENV=dev`)

Same shape as local — `Fluent Dev` org, one GEN+EXO project — but all
credentials come from env vars (`DEV_PM_EMAIL`, `DEV_PM_PASSWORD`,
`DEV_SEED_PASSWORD`); nothing is committed.

| Username      | Email                | Password            | Role Grants                                      |
| ------------- | -------------------- | ------------------- | ------------------------------------------------ |
| `devpm`       | `DEV_PM_EMAIL`       | `DEV_PM_PASSWORD`   | Project Manager (Gujarati → English — GEN & EXO) |
| `alice.smith` | alice.smith@orga.com | `DEV_SEED_PASSWORD` | Project Translator; peer-check pair              |
| `bob.johnson` | bob.johnson@orga.com | `DEV_SEED_PASSWORD` | Project Translator; peer-check pair              |
| `carol.davis` | carol.davis@orga.com | `DEV_SEED_PASSWORD` | Project Translator                               |

#### QA (`SETUP_ENV=qa`)

All 17 accounts share **one password** — committed as a hash
(`QA_DEMO_PASSWORD_HASH` in `qa-spec.ts`, generated via
`npm run db:hash-password`); the plaintext is held by the QA maintainers and
never enters the repo. `cwhite+*@gloo.us` are real plus-aliases so
invite/password-reset email flows can be demoed.

| Username     | Email                                | Org                  | Role Grants                                                           |
| ------------ | ------------------------------------ | -------------------- | --------------------------------------------------------------------- |
| `qa-om`      | qa+fluentqa-om@fluent.local          | Fluent QA            | Org Manager                                                           |
| `qa-pm`      | qa+fluentqa-pm@fluent.local          | Fluent QA            | Org Member only — PM is project-scoped and granted via the UI in QA   |
| `qa-t1`      | qa+fluentqa-translator@fluent.local  | Fluent QA            | Org Member only                                                       |
| `qa-t2`      | qa+fluentqa-translator2@fluent.local | Fluent QA            | Org Member only                                                       |
| `qa-obs`     | qa+fluentqa-observer@fluent.local    | Fluent QA            | Org Member only                                                       |
| `Chad White` | cwhite@gloo.us                       | —                    | **SuperAdmin (global)** — the only grant this user has                |
| `hi-om`      | cwhite+highland-om@gloo.us           | Highland             | Org Manager                                                           |
| `hi-pm`      | cwhite+highland-pm@gloo.us           | Highland + Rivertown | Project Manager on **all 3 projects** — cross-org switcher demo       |
| `hi-t`       | cwhite+highland-translator@gloo.us   | Highland             | Project Translator (Koli Kachi NT)                                    |
| `hi-obs`     | cwhite+highland-observer@gloo.us     | Highland             | Project Observer (Koli Kachi NT + Chichewa OBT)                       |
| `hi-mt1`     | cwhite+highland-mob-t1@gloo.us       | Highland             | Project Translator (Koli Kachi NT + Chichewa OBT); peer-checks hi-mt2 |
| `hi-mt2`     | cwhite+highland-mob-t2@gloo.us       | Highland             | Project Translator (Koli Kachi NT + Chichewa OBT); peer-checks hi-mt1 |
| `hi-mobs`    | cwhite+highland-mob-obs@gloo.us      | Highland             | Project Observer (Koli Kachi NT + Chichewa OBT)                       |
| `rt-om`      | cwhite+rivertown-om@gloo.us          | Rivertown            | Org Manager                                                           |
| `rt-t`       | cwhite+rivertown-translator@gloo.us  | Rivertown            | Project Translator (Wolof General Epistles)                           |
| `rt-obs`     | cwhite+rivertown-observer@gloo.us    | Rivertown            | Project Observer (Wolof General Epistles)                             |
| `nh-om`      | cwhite+newhorizons-om@gloo.us        | New Horizons         | Org Manager — org ships with no projects (first-run state)            |

---

## 💻 3. Command Reference & Usage

### Available NPM Scripts

```bash
# Data Seeding (Migrations + Data Seeding)
npm run db:setup         # Local Docker (SETUP_ENV=local)
npm run db:setup:dev     # Dev Environment (SETUP_ENV=dev)
npm run db:setup:qa      # QA Environment (SETUP_ENV=qa)

# Destructive clean-slate reset (dev/qa only — confirm-gated, see below)
npm run db:reset:dev     # Drops public/drizzle/pgboss, re-runs full setup
npm run db:reset:qa      # Same for QA (never touches the ai schema)

# Seeds only — all reference data + the local demo spec in one shot
npm run db:seed          # org, roles, RBAC, languages, books, bibles, texts, pericope sets, demo spec

# Demo Spec only (re-run just the demo-spec stage: orgs, users, projects, grants)
npm run db:seed:demo:local
npm run db:seed:demo:dev
npm run db:seed:demo:qa

# Password hashing (generate a committed-hash seed credential)
npm run db:hash-password "<password>"

# DB Infrastructure & Role Setup (One-Time Superuser Step)
npm run db:provision:dev # Dev Provisioning (SETUP_ENV=dev)
npm run db:provision:qa  # QA Provisioning (SETUP_ENV=qa)
```

### Complete Workflow Examples per Environment

Environment variables can be supplied in two ways:

- **Option A (`.env` File - Recommended for local/staging runs)**: Add the variables to your `.env` file once, then run `npm run db:provision:<env>` and `npm run db:setup:<env>`.
- **Option B (Inline CLI - Recommended for CI/CD)**: Pass variables directly in the shell command before the `npm run` script.

---

#### 1. Dev Environment (`dev`)

##### Option A: Via `.env` File

Add the following to `.env`:

```env
# ── Step 1: Provisioning (.env entries for npm run db:provision:dev) ─────────
BOOTSTRAP_DATABASE_URL=postgres://<postgres_admin>:<password>@<dev-host>:5432/<dbname>?sslmode=require
API_MIGRATOR_PASSWORD=<api_migrator_password>
API_USER_PASSWORD=<api_user_password>
AI_MIGRATOR_PASSWORD=<ai_migrator_password>
AI_USER_PASSWORD=<ai_user_password>

# ── Step 2: Setup (.env entries for npm run db:setup:dev) ────────────────────
DEV_DATABASE_URL=postgres://api_user:<api_user_password>@<dev-host>:5432/<dbname>?sslmode=require
MIGRATIONS_DATABASE_URL=postgres://api_migrator:<api_migrator_password>@<dev-host>:5432/<dbname>?sslmode=require
DEV_PM_EMAIL=<pm_email>
DEV_PM_PASSWORD=<pm_password>
DEV_SEED_PASSWORD=<seed_translator_password>
```

Execute in terminal:

```bash
# 1. Provision roles and schemas (One-time superuser step)
npm run db:provision:dev

# 2. Run migrations and seed data
npm run db:setup:dev

# 3. Start API app server
npm run dev
```

##### Option B: Via Inline CLI (CI/CD / One-off Execution)

```bash
# 1. Provisioning (Superuser step)
BOOTSTRAP_DATABASE_URL="..." API_MIGRATOR_PASSWORD="..." API_USER_PASSWORD="..." AI_MIGRATOR_PASSWORD="..." AI_USER_PASSWORD="..." npm run db:provision:dev

# 2. Setup (Migrations & Seeding)
DEV_DATABASE_URL="..." MIGRATIONS_DATABASE_URL="..." DEV_PM_EMAIL="..." DEV_PM_PASSWORD="..." DEV_SEED_PASSWORD="..." npm run db:setup:dev
```

---

#### 2. QA / Staging Environment (`qa`)

##### Option A: Via `.env` File

Add the following to `.env`:

```env
# ── Step 1: Provisioning (.env entries for npm run db:provision:qa) ──────────
BOOTSTRAP_DATABASE_URL=postgres://<postgres_admin>:<password>@<qa-host>:5432/<dbname>?sslmode=require
API_MIGRATOR_PASSWORD=<api_migrator_password>
API_USER_PASSWORD=<api_user_password>
AI_MIGRATOR_PASSWORD=<ai_migrator_password>
AI_USER_PASSWORD=<ai_user_password>

# ── Step 2: Setup (.env entries for npm run db:setup:qa) ─────────────────────
# No credential variables needed — every QA account uses the committed
# demo-password hash from qa-spec.ts.
QA_DATABASE_URL=postgres://api_user:<api_user_password>@<qa-host>:5432/<dbname>?sslmode=require
MIGRATIONS_DATABASE_URL=postgres://api_migrator:<api_migrator_password>@<qa-host>:5432/<dbname>?sslmode=require
```

Execute in terminal:

```bash
# 1. Provision roles and schemas (One-time superuser step)
npm run db:provision:qa

# 2. Run migrations and seed data
npm run db:setup:qa

# 3. Start API app server
npm run start
```

##### Option B: Via Inline CLI (CI/CD / One-off Execution)

```bash
# 1. Provisioning (Superuser step)
BOOTSTRAP_DATABASE_URL="..." API_MIGRATOR_PASSWORD="..." API_USER_PASSWORD="..." AI_MIGRATOR_PASSWORD="..." AI_USER_PASSWORD="..." npm run db:provision:qa

# 2. Setup (Migrations & Seeding)
QA_DATABASE_URL="..." MIGRATIONS_DATABASE_URL="..." npm run db:setup:qa
```

---

### Resetting a Dev/QA environment (`db:reset:*`)

`db:reset:dev` / `db:reset:qa` perform a **destructive, manual-only**
clean-slate reset: drop all application data, re-run migrations, and
re-seed the environment's demo spec — a single deterministic path from a
dirty DB back to a known-good state.

```bash
npm run db:reset:qa
#   ⚠️  DESTRUCTIVE DATABASE RESET — QA / Staging
#
#   Target URL     : postgres://api_migrator:****@<qa-host>:5432/fluent_qa
#   Database       : fluent_qa
#
#   This will DROP the public, drizzle, and pgboss schemas (CASCADE),
#   recreate public + pgboss, and re-run migrations + all seeds.
#   The ai schema is not touched.
#
#   Type the database name "fluent_qa" to confirm:
```

#### Guarantees & gates

- `SETUP_ENV` must be `dev` or `qa` — the script refuses anything else
  (including `local`) and points at `docker compose down -v` instead.
- Requires `MIGRATIONS_DATABASE_URL` (the DDL-capable `api_migrator` role,
  never the runtime `api_user`) for the drop/recreate + migrations, **and**
  the usual runtime URL (`<ENV>_DATABASE_URL` → `DATABASE_URL`) for the
  delegated seed stage — the env contract is `setup.ts`'s, plus the reset
  gate on top.
- Prints the masked target URL + database name and aborts unless the
  operator types the exact database name. There is **no** `--yes`/`--force`
  flag — this command is for humans, not CI.

#### What gets dropped / recreated

| Schema    | Fate                                                                |
| --------- | ------------------------------------------------------------------- |
| `public`  | Dropped `CASCADE` → recreated, owner `api_migrator`                 |
| `drizzle` | Dropped `CASCADE` → recreated by `drizzle-kit migrate` during setup |
| `pgboss`  | Dropped `CASCADE` → recreated, owner `api_user`                     |
| `ai`      | **Never touched** — it belongs to the AI service                    |

The drop also destroys the schema-scoped default-privilege rules, so the
reset re-establishes the `api_migrator → api_user` default privileges on
`public` _before_ delegating — otherwise the runtime role couldn't read the
tables migrations are about to create. It then runs `setup.ts` unchanged:
migrations + all reference seeds + the environment's demo spec.

> **One-time prerequisite:** databases provisioned before this change need
> `npm run db:provision:<env>` re-run once — it now grants `api_user` to
> `api_migrator`, which the DDL role needs in order to drop and re-own the
> `api_user`-owned `pgboss` schema.

**Local Docker:** don't use `db:reset` — wipe the volume instead with
`docker compose down -v` (or `./fapi.sh clean`). The script exits non-zero
for `SETUP_ENV=local`.

---

## 🔍 4. Verification SQL Snippet

To verify proper role seeding in PostgreSQL:

```sql
SELECT
  ur.id,
  ur.user_id,
  u.username,
  ur.org_id,
  ur.project_id,
  r.name as role_name
FROM user_roles ur
JOIN users u ON ur.user_id = u.id
JOIN roles r ON ur.role_id = r.id
ORDER BY ur.id ASC;
```

**Expected Output Structure:**

```text
 id | user_id | username   | org_id | project_id |    role_name
----+---------+------------+--------+------------+------------------
  1 |       1 | devpm      |      1 |            | Org Member
  2 |       1 | devpm      |        |          1 | Project Manager
  3 |       2 | translator |      1 |            | Org Member
  4 |       2 | translator |        |          1 | Project Translator
```

Note the scoping: `Org Member` carries `org_id`, while project roles
(`Project Manager` / `Project Translator` / `Project Observer`) carry
`project_id`. A project-level role with `project_id IS NULL` is stale and
the demo seed engine deletes it on the next run (for the users the spec
manages).
