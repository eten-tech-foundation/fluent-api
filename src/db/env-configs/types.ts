/**
 * A seed user to be created during DB setup.
 * Credentials live here intentionally — these are controlled dev/qa accounts,
 * not application runtime secrets.
 */
export interface SeedUser {
  email: string;
  password: string;
  username: string;
  role: 'project_manager' | 'project_translator' | 'org_member';
}

/**
 * DB-level role provisioning config used by `provision-db.ts`.
 * Only relevant for dev / qa environments (not local docker, which uses
 * `bootstrap.ts` instead).
 */
export interface DbProvisionConfig {
  /** Superuser / azure_pg_admin connection URL — used to create roles. */
  bootstrapDatabaseUrl: string;
  /** Password for the `db_admin` login role (schema owner, CREATEROLE). */
  dbAdminPassword: string;
  /** Password for the `migrations` login role (Drizzle kit). */
  migrationsPassword: string;
  /** Password for the `web_user` login role (API runtime). */
  webUserPassword: string;
  /** Password for the `ai_user` login role (AI service runtime). */
  aiUserPassword: string;
}

/**
 * Full configuration for one target environment.
 * Each env-config file exports a single `config` object of this type.
 */
export interface EnvConfig {
  /** Human-readable label printed during setup (e.g. 'Local Docker', 'Dev'). */
  label: string;

  /**
   * Organisation name to seed.
   * If the org already exists (idempotent run) the name is unchanged.
   */
  orgName: string;

  /**
   * Optional explicit database URL.
   * When set, `setup.ts` overwrites `process.env.DATABASE_URL` before any
   * DB-dependent work runs, so you don't need to pre-set the env var.
   * When absent, `DATABASE_URL` must already be set in the environment.
   */
  databaseUrl?: string;

  /**
   * Users to seed.
   * Empty array → no application users are seeded (useful for a QA env that
   * wants a fully blank slate beyond the PM account, or if you want none at all).
   */
  seedUsers: SeedUser[];

  /**
   * When true, a credential summary is printed at the end of setup.
   * Keep false for environments where you don't want passwords in logs.
   */
  printCredentials: boolean;

  /**
   * DB-level role provisioning config.
   * Required when running `provision-db.ts` for this environment.
   * Not used by `setup.ts`.
   */
  provision?: DbProvisionConfig;
}
