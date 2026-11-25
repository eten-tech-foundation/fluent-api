import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// __dirname is not available in ESM; derive it from import.meta.url
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Multiple PGlite WASM integration suites run in parallel at the start of a
    // full run; capping worker forks and raising hookTimeout prevents cold
    // PGlite bootstrap hooks and whole-app imports from starving under CPU/RAM
    // contention without weakening any test assertions.
    hookTimeout: 30_000,
    poolOptions: {
      forks: {
        maxForks: 4,
      },
    },
    // Agent tooling checks out sibling branches into .claude/worktrees/<branch>/,
    // each a full copy of this repo. Without this exclude, vitest collects those
    // copies' suites too and reports another branch's failures as if they were
    // ours. CI is unaffected (a clean checkout has no .claude/), so this only
    // keeps local runs honest.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/**',
      '**/worktrees/**',
      '**/*.live.test.ts',
      '**/*.db.test.ts',
    ],
  },
});
