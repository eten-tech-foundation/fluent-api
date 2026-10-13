import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Additional DB/auth checks against the normal, seeded local platform database.
// No extra database/container and no provider key. This explicit command creates a test
// session and a temporary draft, then reruns the normal seeds. Never target shared Dev/QA.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl)
  throw new Error('test:db needs the local platform DATABASE_URL; run local setup first.');
const database = new URL(databaseUrl);
if (
  !['localhost', '127.0.0.1', '[::1]', 'db'].includes(database.hostname) ||
  database.pathname !== '/fluent'
) {
  throw new Error(
    'test:db only targets the normal local Fluent database (loopback or Compose db host).'
  );
}

export default defineConfig({
  resolve: { alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src') } },
  test: {
    include: ['src/**/*.db.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
