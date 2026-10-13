import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Folder that will be deployed
const deployRootName = process.env.WEBJOB_ROOT ?? 'wwwroot';
const deployRoot = join(repoRoot, deployRootName);

if (!existsSync(deployRoot)) {
  mkdirSync(deployRoot, { recursive: true });
}

const webjobDir = join(deployRoot, 'App_Data', 'jobs', 'continuous', 'worker');

if (existsSync(webjobDir)) {
  rmSync(webjobDir, { recursive: true, force: true });
}

mkdirSync(webjobDir, { recursive: true });

const distDir = join(deployRoot, 'dist');
if (!existsSync(distDir)) {
  console.error(`Dist folder not found at ${distDir}.`);
  process.exit(1);
}

const nodeModulesDir = join(deployRoot, 'node_modules');
if (!existsSync(nodeModulesDir)) {
  console.error(`node_modules not found at ${nodeModulesDir}.`);
  process.exit(1);
}

cpSync(distDir, join(webjobDir, 'dist'), { recursive: true });
cpSync(nodeModulesDir, join(webjobDir, 'node_modules'), { recursive: true });

const packageJsonPath = join(deployRoot, 'package.json');
if (existsSync(packageJsonPath)) {
  copyFileSync(packageJsonPath, join(webjobDir, 'package.json'));
}

const runScript = `#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

(async () => {
  const workerPath = resolve(__dirname, 'dist/src/workers/standalone-worker.js');

  try {
    await import(workerPath);
  } catch (err) {
    console.error('Failed to start worker from WebJob:', err);
    process.exit(1);
  }
})();
`;

const runMjsPath = join(webjobDir, 'run.mjs');
writeFileSync(runMjsPath, runScript);

try {
  chmodSync(runMjsPath, 0o755);
} catch {
  // ignore chmod errors on platforms that do not support it
}

const settings = {
  stopping_wait_time: 60,
};

writeFileSync(join(webjobDir, 'settings.job'), JSON.stringify(settings, null, 2));

const runCmd = `@echo off
cd /d "%~dp0"
node run.mjs
`;

writeFileSync(join(webjobDir, 'run.cmd'), runCmd);

const runSh = `#!/usr/bin/env bash
cd "$(dirname "$0")"
node run.mjs
`;

const runShPath = join(webjobDir, 'run.sh');
writeFileSync(runShPath, runSh);

try {
  chmodSync(runShPath, 0o755);
} catch {
  // ignore chmod errors
}

const envFile = join(repoRoot, '.env');
if (existsSync(envFile)) {
  copyFileSync(envFile, join(webjobDir, '.env'));
}
