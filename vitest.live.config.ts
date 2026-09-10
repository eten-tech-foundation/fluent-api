import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Provider-backed checks are opt-in: the default CI suite has no Aquifer secret.
// Database-only verification belongs to test:db and does not need this key.
if (!process.env.AQUIFER_API_KEY)
  throw new Error('test:live needs AQUIFER_API_KEY; live checks were not run.');

export default defineConfig({
  resolve: { alias: { '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), './src') } },
  test: {
    include: ['src/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
