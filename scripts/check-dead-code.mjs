#!/usr/bin/env node
// FA-C1: fails on dead code (unused files, exports, types, dependencies) that is not in
// knip-baseline.json, and on baseline entries that no longer occur, so the baseline only
// shrinks. Mirrors how eslint-suppressions.json works for lint rules.
//
//   npm run deadcode            check against the baseline
//   npm run deadcode -- --update  drop entries that no longer occur (refuses to add new ones)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BASELINE = 'knip-baseline.json';
const update = process.argv.includes('--update');

// knip loads every vitest config package.json references. vitest.db.config.ts and
// vitest.live.config.ts throw when their env vars are unset or empty (as in CI), so give
// them placeholders. Nothing connects; knip only reads the configs' include patterns.
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://localhost:5432/fluent',
  AQUIFER_API_KEY: process.env.AQUIFER_API_KEY || 'knip-placeholder',
};

const report = JSON.parse(
  execFileSync('npx', ['knip', '--reporter', 'json', '--no-exit-code'], {
    encoding: 'utf8',
    env,
    maxBuffer: 64 * 1024 * 1024,
  })
);

const current = new Set(report.files.map((file) => `files:${file}`));
for (const issue of report.issues) {
  for (const [kind, entries] of Object.entries(issue)) {
    if (kind === 'file') continue;
    const items = Array.isArray(entries) ? entries : Object.values(entries).flat();
    for (const item of items) current.add(`${kind}:${issue.file}:${item.name}`);
  }
}

const baseline = new Set(JSON.parse(readFileSync(BASELINE, 'utf8')));
const added = [...current].filter((key) => !baseline.has(key)).sort();
const stale = [...baseline].filter((key) => !current.has(key)).sort();

if (update && added.length === 0) {
  writeFileSync(BASELINE, `${JSON.stringify([...current].sort(), null, 2)}\n`);
  process.stdout.write(`Removed ${stale.length} entries; ${current.size} remain in ${BASELINE}.\n`);
  process.exit(0);
}

if (added.length > 0) {
  process.stdout.write(
    `FA-C1: new dead code (remove it, or export only what another module imports):\n${added
      .map((key) => `  ${key}`)
      .join('\n')}\n`
  );
}
if (stale.length > 0) {
  process.stdout.write(
    `FA-C1: ${stale.length} baseline entries no longer occur. Run \`npm run deadcode -- --update\` and commit ${BASELINE}:\n${stale
      .map((key) => `  ${key}`)
      .join('\n')}\n`
  );
}
if (added.length > 0 || stale.length > 0) process.exit(1);
process.stdout.write(`No new dead code (${baseline.size} grandfathered in ${BASELINE}).\n`);
