/**
 * Demo spec seed entry point.
 *
 * `seedDemoSpec` lazy-loads the engine because the engine pulls in the db
 * client, which reads DATABASE_URL at import time — callers that set it
 * in-process (setup.ts, the CLI below) must not trigger that import early.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';

import type { EnvConfig } from '@/db/env-configs/types';

import { applyDatabaseUrl } from '@/db/env-configs/database-url';

import type { DemoSpec } from './types';

export { devSpec } from './dev-spec';
export { buildGrantPlan, isStaleProjectRoleGrant } from './grants';
export { spread } from './spread';
export * from './types';

export async function seedDemoSpec(spec: DemoSpec): Promise<void> {
  const { seedDemoSpec: impl } = await import('./engine');
  return impl(spec);
}

const VALID_ENVS = ['local', 'dev', 'qa'] as const;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envName = process.env.SETUP_ENV ?? 'local';

  const main = async () => {
    if (!VALID_ENVS.includes(envName as (typeof VALID_ENVS)[number])) {
      console.error(`❌  Unknown SETUP_ENV="${envName}". Valid values: ${VALID_ENVS.join(', ')}`);
      process.exit(1);
    }

    const { config } = (await import(`@/db/env-configs/${envName}`)) as { config: EnvConfig };

    const maskedUrl = applyDatabaseUrl(config);
    if (!maskedUrl) {
      console.error(
        `❌  No database URL for environment "${envName}".\n` +
          `   Set DEV_DATABASE_URL / QA_DATABASE_URL (or DATABASE_URL for local).`
      );
      process.exit(1);
    }
    console.log(`ℹ  DATABASE_URL → ${maskedUrl}\n`);

    if (!config.demoSpec) {
      console.error(`❌  env-config "${envName}" does not define a demoSpec.`);
      process.exit(1);
    }

    await seedDemoSpec(config.demoSpec);
  };

  main()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error('Demo seed failed:', err);
      process.exit(1);
    });
}
