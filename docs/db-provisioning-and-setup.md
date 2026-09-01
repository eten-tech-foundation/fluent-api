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
       ├── Create DB Roles & Accounts: web_user, ai_user, db_admin
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
  - Creates database logins (`web_user`, `ai_user`, `migrations`, `db_admin`), schemas (`public`, `ai`, `pgboss`), and security privileges.
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

| Variable Name                 | Required By         | Description / Format                                                                          | Example Value                                              |
| ----------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`                | `setup.ts` (local)  | Runtime role URL injected by docker-compose for local. Last-resort fallback for dev/qa.       | `postgres://web_user:pass@localhost:5432/fluentdb`         |
| `MIGRATIONS_DATABASE_URL`     | `drizzle.config.ts` | Direct DDL migration connection URL (read directly by drizzle-kit).                           | `postgres://migrations:pass@localhost:5432/fluentdb`       |
| `DEV_DATABASE_URL`            | `setup.ts` (dev)    | Runtime role URL for dev — **wins over** `DATABASE_URL` when `SETUP_ENV=dev`.                 | `postgres://web_user:pass@dev-host:5432/fluentdb`          |
| `DEV_MIGRATIONS_DATABASE_URL` | `setup.ts` (dev)    | Migrations role URL for dev — passed to `drizzle-kit migrate` (DDL rights).                   | `postgres://migrations:pass@dev-host:5432/fluentdb`        |
| `QA_DATABASE_URL`             | `setup.ts` (qa)     | Runtime role URL for QA — **wins over** `DATABASE_URL` when `SETUP_ENV=qa`.                   | `postgres://web_user:pass@qa-host:5432/fluentdb`           |
| `QA_MIGRATIONS_DATABASE_URL`  | `setup.ts` (qa)     | Migrations role URL for QA — passed to `drizzle-kit migrate` (DDL rights).                    | `postgres://migrations:pass@qa-host:5432/fluentdb`         |
| `BOOTSTRAP_DATABASE_URL`      | `provision-db.ts`   | Superuser / Admin URL to create roles & schemas                                               | `postgres://admin:pass@host:5432/fluentdb?sslmode=require` |
| `DB_ADMIN_PASSWORD`           | `provision-db.ts`   | Password for the schema-owner `db_admin` role                                                 | `SecretDbAdminPass123`                                     |
| `MIGRATIONS_PASSWORD`         | `provision-db.ts`   | Password for the DDL migration runner `migrations` user                                       | `SecretMigrationsPass123`                                  |
| `WEB_USER_PASSWORD`           | `provision-db.ts`   | Password for the API runtime `web_user` account                                               | `SecretWebUserPass123`                                     |
| `AI_USER_PASSWORD`            | `provision-db.ts`   | Password for the AI service `ai_user` account                                                 | `SecretAiUserPass123`                                      |
| `QA_PM_EMAIL`                 | `setup.ts` (qa)     | Required at seed time — validated lazily so `provision-db.ts` can import `qa.ts` without it.  | `pm@yourorg.com`                                           |
| `QA_PM_PASSWORD`              | `setup.ts` (qa)     | Required at seed time — validated lazily so `provision-db.ts` can import `qa.ts` without it.  | `StrongPassword!1`                                         |
| `DEV_PM_EMAIL`                | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it. | `pm@yourorg.com`                                           |
| `DEV_PM_PASSWORD`             | `setup.ts` (dev)    | Required at seed time — validated lazily so `provision-db.ts` can import `dev.ts` without it. | `StrongPassword!1`                                         |
| `DEV_SEED_PASSWORD`           | `setup.ts` (dev)    | Shared password for the 3 translator accounts (`alice.smith`, `bob.johnson`, `carol.davis`).  | `StrongPassword!2`                                         |

> **URL resolution order for `db:setup:dev`:**
> `DEV_DATABASE_URL` → `DATABASE_URL` (last resort). `DEV_MIGRATIONS_DATABASE_URL` is passed to
> `drizzle-kit migrate` so it runs as the DDL-capable `migrations` role rather than `web_user`.
> This matches `drizzle.config.ts` which prefers `MIGRATIONS_DATABASE_URL ?? DATABASE_URL`.

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

`provision-db.ts` enforces **least-privilege security**. Instead of running the web server as a database superuser, access is partitioned into **Group Roles** (un-loggable permissions) and **Login Accounts**.

### PostgreSQL Group Roles (No `LOGIN`)

| Group Role         | Target Schema | Granted Privileges                                           | Purpose                                                                                                |
| ------------------ | ------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `role_web_data`    | `public`      | `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SEQUENCES` | Full DML access for the Web API server.                                                                |
| `role_ai_data`     | `ai`          | `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SEQUENCES` | Full DML access for the AI processing service.                                                         |
| `role_ai_reader`   | `public`      | `USAGE`, `SELECT`                                            | Read-only access to `public` schema for cross-schema AI analysis.                                      |
| `role_pgboss_user` | `pgboss`      | Schema owner via `web_user` (see below)                      | Anchor group role — `web_user` owns the pgboss schema so pg-boss can manage its own tables at runtime. |
| `role_migrations`  | All schemas   | `USAGE`, `CREATE`, `ALL PRIVILEGES`                          | DDL + DML rights across all schemas for migration runners.                                             |

### Login Users & Membership Mapping

| Login Account | Granted Group Roles                                  | Target Schemas / Privileges                   |
| ------------- | ---------------------------------------------------- | --------------------------------------------- |
| `web_user`    | `role_web_data`, `role_pgboss_user`                  | DML on `public` and `pgboss` schemas          |
| `ai_user`     | `role_ai_data`, `role_ai_reader`, `role_pgboss_user` | DML on `ai` & `pgboss`, Read-only on `public` |
| `migrations`  | `role_migrations`                                    | DDL + DML across all schemas                  |
| `db_admin`    | _(Schema Owner)_                                     | Schema owner: `public`, `ai`, `drizzle`       |

> **pgboss schema:** Owned by `web_user` (not `db_admin`) so pg-boss can create its own tables,
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
DB_ADMIN_PASSWORD=<db_admin_password>
MIGRATIONS_PASSWORD=<migrations_password>
WEB_USER_PASSWORD=<web_user_password>
AI_USER_PASSWORD=<ai_user_password>

# ── Step 2: Setup (.env entries for npm run db:setup:dev) ────────────────────
DEV_DATABASE_URL=postgres://web_user:<web_user_password>@<dev-host>:5432/<dbname>?sslmode=require
DEV_MIGRATIONS_DATABASE_URL=postgres://migrations:<migrations_password>@<dev-host>:5432/<dbname>?sslmode=require
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
BOOTSTRAP_DATABASE_URL="..." DB_ADMIN_PASSWORD="..." MIGRATIONS_PASSWORD="..." WEB_USER_PASSWORD="..." AI_USER_PASSWORD="..." npm run db:provision:dev

# 2. Setup (Migrations & Seeding)
DEV_DATABASE_URL="..." DEV_MIGRATIONS_DATABASE_URL="..." DEV_PM_EMAIL="..." DEV_PM_PASSWORD="..." DEV_SEED_PASSWORD="..." npm run db:setup:dev
```

---

#### 2. QA / Staging Environment (`qa`)

##### Option A: Via `.env` File

Add the following to `.env`:

```env
# ── Step 1: Provisioning (.env entries for npm run db:provision:qa) ──────────
BOOTSTRAP_DATABASE_URL=postgres://<postgres_admin>:<password>@<qa-host>:5432/<dbname>?sslmode=require
DB_ADMIN_PASSWORD=<db_admin_password>
MIGRATIONS_PASSWORD=<migrations_password>
WEB_USER_PASSWORD=<web_user_password>
AI_USER_PASSWORD=<ai_user_password>

# ── Step 2: Setup (.env entries for npm run db:setup:qa) ─────────────────────
QA_DATABASE_URL=postgres://web_user:<web_user_password>@<qa-host>:5432/<dbname>?sslmode=require
QA_MIGRATIONS_DATABASE_URL=postgres://migrations:<migrations_password>@<qa-host>:5432/<dbname>?sslmode=require
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
BOOTSTRAP_DATABASE_URL="..." DB_ADMIN_PASSWORD="..." MIGRATIONS_PASSWORD="..." WEB_USER_PASSWORD="..." AI_USER_PASSWORD="..." npm run db:provision:qa

# 2. Setup (Migrations & Seeding)
QA_DATABASE_URL="..." QA_MIGRATIONS_DATABASE_URL="..." QA_PM_EMAIL="..." QA_PM_PASSWORD="..." npm run db:setup:qa
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
