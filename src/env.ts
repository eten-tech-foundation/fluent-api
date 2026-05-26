import { z } from '@hono/zod-openapi';
import { config } from 'dotenv';
import { expand } from 'dotenv-expand';
import path from 'node:path';

expand(
  config({
    path: path.resolve(process.cwd(), process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
  })
);

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(9999),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
    .optional(),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_COOKIE_DOMAIN: z.string().default('.fluent.bible'),
  BETTER_AUTH_SESSION_EXPIRY_SECONDS: z.coerce.number().default(60 * 60 * 24 * 7), // 7 days
  APPLICATIONINSIGHTS_CONNECTION_STRING: z.string(),

  EMAIL_SERVICE_API_KEY: z.string(),
  EMAIL_SERVICE_DOMAIN: z.string(),
  EMAIL_SERVICE_SENDER: z.string(),
  FRONTEND_URL: z.string(),
});

export type env = z.infer<typeof EnvSchema>;

// eslint-disable-next-line ts/no-redeclare
const { data: env, error } = EnvSchema.safeParse(process.env);

if (error) {
  console.error('❌ Invalid env:');
  console.error(JSON.stringify(error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export default env!;
