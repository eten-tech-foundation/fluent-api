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
       └── Seed Initial Users & Bible Texts
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
| `QA_PM_EMAIL`             | `setup.ts` (qa)     | Required at seed time — validated lazily so `provision-db.ts` can import `qa.ts` without it.                                                                                                                                                         | `pm@yourorg.com`                                           |
| `QA_PM_PASSWORD`          | `setup.ts` (qa)     | Required at seed time — validated lazily so `provision-db.ts` can import `qa.ts` without it.                                                                                                                                                         | `StrongPassword!1`                                         |
| `DEV_PM_EMAIL`            | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it.                                                                                                                                                        | `pm@yourorg.com`                                           |
| `DEV_PM_PASSWORD`         | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it.                                                                                                                                                        | `StrongPassword!1`                                         |
| `DEV_SEED_PASSWORD`       | `setup.ts` (dev)    | Shared password for the 3 translator accounts (`alice.smith`, `bob.johnson`, `carol.davis`).                                                                                                                                                         | `StrongPassword!2`                                         |

> **URL resolution order for `db:setup:dev`:**
> `DEV_DATABASE_URL` → `DATABASE_URL` (last resort) for the runtime connection.
> `MIGRATIONS_DATABASE_URL`, if set, is passed straight through to
> `drizzle-kit migrate` so it runs as the DDL-capable `api_migrator` role
> rather than `api_user` — this is the same variable in every environment,
> per `drizzle.config.ts`'s `MIGRATIONS_DATABASE_URL ?? DATABASE_URL`.

---

## 📂 Component & File Inventory (13 Files)

The database provisioning and environment-aware seeding system consists of 13 key files across `fluent-api`, organized by role:

### 1. Environment Configurations (`src/db/env-configs/`)

| File Path                     | Status  | Environment       | Configured Seed Data                                                                                                                                                  |
| ----------------------------- | ------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/env-configs/local.ts` | `[NEW]` | Local Docker      | 3 default local users (`devpm`, `translator`, `translator2`).                                                                                                         |
| `src/db/env-configs/dev.ts`   | `[NEW]` | Shared Dev Server | `Fluent Dev` org. PM via `DEV_PM_EMAIL`/`DEV_PM_PASSWORD`. Translators (`alice.smith`, `bob.johnson`, `carol.davis`) via `DEV_SEED_PASSWORD`. No hardcoded passwords. |
| `src/db/env-configs/qa.ts`    | `[NEW]` | QA / Staging      | `Fluent QA` org, single QA project manager (`qapm`).                                                                                                                  |

### 2. Core Scripts & Shared Types

| File Path                        | Status       | Purpose & Usage                                                                                                                           |
| -------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/env-configs/types.ts`    | `[NEW]`      | TypeScript interfaces defining `EnvConfig`, `DbProvisionConfig`, and `SeedUser`.                                                          |
| `src/db/scripts/provision-db.ts` | `[NEW]`      | One-time superuser DDL script for database role creation, user upserts, schema creation, and default privileges.                          |
| `src/db/scripts/setup.ts`        | `[MODIFIED]` | Environment-aware setup orchestrator (`SETUP_ENV=local/dev/qa`), dynamic `DATABASE_URL` resolution, and Drizzle migration runner.         |
| `src/db/seeds/dev-users.ts`      | `[MODIFIED]` | Universal user seeding worker (seeds configured users across `local`, `dev`, and `qa` environments with `ROLES.ORG_MEMBER` anchor roles). |
| `src/db/seeds/organizations.ts`  | `[MODIFIED]` | Parameterized organization seeding accepting custom org names per environment.                                                            |

### 3. Documentation

| File Path                           | Status       | Purpose & Usage                                                   |
| ----------------------------------- | ------------ | ----------------------------------------------------------------- |
| `docs/db-provisioning-and-setup.md` | `[NEW]`      | Comprehensive architecture and operational reference guide.       |
| `README.md`                         | `[MODIFIED]` | Linked database setup documentation in the main repository index. |

### 4. Infrastructure & Project Configurations

| File Path              | Status       | Purpose & Usage                                                                                                                                                  |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json`         | `[MODIFIED]` | Added CLI scripts (`db:setup:dev`, `db:setup:qa`, `db:provision:dev`, `db:provision:qa`).                                                                        |
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

| `SETUP_ENV` | Config File                   | Usage             | Seed Strategy                                                                                                                        |
| ----------- | ----------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `local`     | `src/db/env-configs/local.ts` | Local Docker      | 3 default local users (`devpm`, `translator`, `translator2`)                                                                         |
| `dev`       | `src/db/env-configs/dev.ts`   | Shared Dev Server | PM (`DEV_PM_EMAIL`) + 3 translators (`alice.smith`, `bob.johnson`, `carol.davis`) via `DEV_SEED_PASSWORD`. No hardcoded credentials. |
| `qa`        | `src/db/env-configs/qa.ts`    | Staging / QA      | 1 QA Project Manager (`qapm`)                                                                                                        |

---

## 💻 3. Command Reference & Usage

### Available NPM Scripts

```bash
# Data Seeding (Migrations + Data Seeding)
npm run db:setup         # Local Docker (SETUP_ENV=local)
npm run db:setup:dev     # Dev Environment (SETUP_ENV=dev)
npm run db:setup:qa      # QA Environment (SETUP_ENV=qa)

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
QA_DATABASE_URL=postgres://api_user:<api_user_password>@<qa-host>:5432/<dbname>?sslmode=require
MIGRATIONS_DATABASE_URL=postgres://api_migrator:<api_migrator_password>@<qa-host>:5432/<dbname>?sslmode=require
QA_PM_EMAIL=<qapm_email>
QA_PM_PASSWORD=<qapm_password>
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
QA_DATABASE_URL="..." MIGRATIONS_DATABASE_URL="..." QA_PM_EMAIL="..." QA_PM_PASSWORD="..." npm run db:setup:qa
```

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
 id | user_id |  username   | org_id | project_id |    role_name
----+---------+-------------+--------+------------+-----------------
  1 |       1 | qa.manager  |      1 |            | Org Member
  2 |       1 | qa.manager  |      1 |            | Project Manager
  3 |       2 | alice.smith |      1 |            | Org Member
  4 |       3 | bob.johnson |      1 |            | Org Member
  5 |       4 | carol.davis |      1 |            | Org Member
```
