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

You can configure database URLs and credentials in three different places depending on your workflow:

1. **Local Development (`.env` File)**: Place variables in your local `.env` file at the root of `fluent-api`.
2. **Cloud / CI/CD (Environment Variables)**: Set environment variables in Azure App Service Configuration, GitHub Repository Secrets, or container environment settings.
3. **Inline CLI Flag (One-off Execution)**: Pass environment variables directly in your terminal command.

### Environment Variable Catalog

| Variable Name            | Required By       | Description / Format                                    | Example Value                                              |
| ------------------------ | ----------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `DATABASE_URL`           | `setup.ts`        | Connection URL for application runtime & migrations     | `postgres://web_user:pass@localhost:5432/fluentdb`         |
| `DEV_DATABASE_URL`       | `setup.ts` (Dev)  | Optional Dev-specific override URL                      | `postgres://postgres:pass@localhost:5432/fluent_dev`       |
| `QA_DATABASE_URL`        | `setup.ts` (QA)   | Optional QA-specific override URL                       | `postgres://web_user:pass@qa-host:5432/fluentdb`           |
| `BOOTSTRAP_DATABASE_URL` | `provision-db.ts` | Superuser / Admin URL to create roles & schemas         | `postgres://admin:pass@host:5432/fluentdb?sslmode=require` |
| `DB_ADMIN_PASSWORD`      | `provision-db.ts` | Password for the schema-owner `db_admin` role           | `SecretDbAdminPass123`                                     |
| `MIGRATIONS_PASSWORD`    | `provision-db.ts` | Password for the DDL migration runner `migrations` user | `SecretMigrationsPass123`                                  |
| `WEB_USER_PASSWORD`      | `provision-db.ts` | Password for the API runtime `web_user` account         | `SecretWebUserPass123`                                     |
| `AI_USER_PASSWORD`       | `provision-db.ts` | Password for the AI service `ai_user` account           | `SecretAiUserPass123`                                      |

---

## 📂 Component & File Inventory (13 Files)

The database provisioning and environment-aware seeding system consists of 13 key files across `fluent-api`, organized by role:

### 1. Environment Configurations (`src/db/env-configs/`)

| File Path                     | Status  | Environment       | Configured Seed Data                                                                                    |
| ----------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------- |
| `src/db/env-configs/local.ts` | `[NEW]` | Local Docker      | 3 default local users (`devpm`, `translator`, `translator2`).                                           |
| `src/db/env-configs/dev.ts`   | `[NEW]` | Shared Dev Server | `Fluent Dev` org, QA manager (`qa.manager`), translators (`alice.smith`, `bob.johnson`, `carol.davis`). |
| `src/db/env-configs/qa.ts`    | `[NEW]` | QA / Staging      | `Fluent QA` org, single QA project manager (`qapm`).                                                    |

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

| File Path              | Status       | Purpose & Usage                                                                           |
| ---------------------- | ------------ | ----------------------------------------------------------------------------------------- |
| `package.json`         | `[MODIFIED]` | Added CLI scripts (`db:setup:dev`, `db:setup:qa`, `db:provision:dev`, `db:provision:qa`). |
| `docker-entrypoint.sh` | `[MODIFIED]` | Configured local Docker container startup to set `SETUP_ENV=local`.                       |
| `src/lib/queue.ts`     | `[MODIFIED]` | Configured `pgboss` queue initialization options (`createSchema: true`).                  |

---

## 🔒 1. Database Role & Security Hierarchy (`provision-db.ts`)

`provision-db.ts` enforces **least-privilege security**. Instead of running the web server as a database superuser, access is partitioned into **Group Roles** (un-loggable permissions) and **Login Accounts**.

### PostgreSQL Group Roles (No `LOGIN`)

| Group Role         | Target Schema | Granted Privileges                                           | Purpose                                                           |
| ------------------ | ------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `role_web_data`    | `public`      | `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SEQUENCES` | Full DML access for the Web API server.                           |
| `role_ai_data`     | `ai`          | `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SEQUENCES` | Full DML access for the AI processing service.                    |
| `role_ai_reader`   | `public`      | `USAGE`, `SELECT`                                            | Read-only access to `public` schema for cross-schema AI analysis. |
| `role_pgboss_user` | `pgboss`      | `USAGE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `SEQUENCES` | Access to `pg-boss` background job queues.                        |
| `role_migrations`  | All schemas   | `USAGE`, `CREATE`, `ALL PRIVILEGES`                          | DDL + DML rights across all schemas for migration runners.        |

### Login Users & Membership Mapping

| Login Account | Granted Group Roles                                  | Target Schemas / Privileges                        |
| ------------- | ---------------------------------------------------- | -------------------------------------------------- |
| `web_user`    | `role_web_data`, `role_pgboss_user`                  | DML on `public` and `pgboss` schemas               |
| `ai_user`     | `role_ai_data`, `role_ai_reader`, `role_pgboss_user` | DML on `ai` & `pgboss`, Read-only on `public`      |
| `migrations`  | `role_migrations`                                    | DDL + DML across all schemas                       |
| `db_admin`    | _(Schema Owner)_                                     | Schema Owner (`public`, `ai`, `pgboss`, `drizzle`) |

---

## ⚙️ 2. Environment Setup & Connection Resolution (`setup.ts`)

`setup.ts` orchestrates running Drizzle ORM migrations and seeding data according to the target environment specified by `SETUP_ENV`.

### Target Environments

| `SETUP_ENV` | Config File                   | Usage             | Seed Strategy                                                                 |
| ----------- | ----------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| `local`     | `src/db/env-configs/local.ts` | Local Docker      | 3 default local users (`devpm`, `translator`, `translator2`)                  |
| `dev`       | `src/db/env-configs/dev.ts`   | Shared Dev Server | PM (`qa.manager`) + Translators (`alice.smith`, `bob.johnson`, `carol.davis`) |
| `qa`        | `src/db/env-configs/qa.ts`    | Staging / QA      | 1 QA Project Manager (`qapm`)                                                 |

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

### Typical Workflow for a Fresh Remote Database

1. **Step 1: Run One-Time Infrastructure & Role Setup**

   ```bash
   BOOTSTRAP_DATABASE_URL="postgres://admin:secret@dev-db.postgres.database.azure.com:5432/fluentdb?sslmode=require" \
   npm run db:provision:dev
   ```

2. **Step 2: Run Migrations & Data Seeding**
   ```bash
   DATABASE_URL="postgres://migrations:secret@dev-db.postgres.database.azure.com:5432/fluentdb?sslmode=require" \
   npm run db:setup:dev
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
