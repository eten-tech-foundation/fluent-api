import type { DemoSpec } from '@/db/seeds/demo/types';

/**
 * DB-level role provisioning config used by `provision-db.ts`.
 * Only relevant for dev / qa environments (not local docker, which uses
 * `bootstrap.ts` instead).
 */
export interface DbProvisionConfig {
  /** Superuser / azure_pg_admin connection URL — used to create roles. */
  bootstrapDatabaseUrl: string;
  /** Password for the `api_migrator` login role (API migrations + public/drizzle ownership). */
  apiMigratorPassword: string;
  /** Password for the `api_user` login role (API runtime). */
  apiUserPassword: string;
  /** Password for the `ai_migrator` login role (AI migrations + ai schema ownership). */
  aiMigratorPassword: string;
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
   * Optional explicit database URL for the application runtime role.
   * Used by `setup.ts` to set `DATABASE_URL` — the env-config owns this value
   * (e.g. `DEV_DATABASE_URL` for dev), so it always wins over any generic
   * `DATABASE_URL` that may be exported in the shell.
   * When absent for `local`, docker-compose injects `DATABASE_URL` directly.
   */
  databaseUrl?: string;

  /**
   * Declarative demo spec seeded by the `seedDemoSpec` engine — the only
   * user/content seeding path; `setup.ts` runs it after all reference seeds.
   * Absent → no application users or demo content are seeded.
   */
  demoSpec?: DemoSpec;

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
