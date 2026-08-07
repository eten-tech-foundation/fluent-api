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
    // Agent tooling checks out sibling branches into .claude/worktrees/<branch>/,
    // each a full copy of this repo. Without this exclude, vitest collects those
    // copies' suites too and reports another branch's failures as if they were
    // ours. CI is unaffected (a clean checkout has no .claude/), so this only
    // keeps local runs honest.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.claude/**'],
  },
});
