import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'src/db/scripts/reset-db.ts';

/**
 * Runs reset-db.ts as a subprocess. `DOTENV_CONFIG_PATH` points at a
 * nonexistent file so the repo's real .env can't leak a
 * MIGRATIONS_DATABASE_URL into "missing var" tests.
 */
function runScript(envOverrides: Record<string, string | undefined>, input = '') {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    DOTENV_CONFIG_PATH: '/nonexistent/.env',
  };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return spawnSync('npx', ['tsx', SCRIPT], {
    encoding: 'utf-8',
    timeout: 30_000,
    input,
    env,
  });
}

const MIGRATIONS_ENV = {
  SETUP_ENV: 'dev',
  MIGRATIONS_DATABASE_URL: 'postgres://miguser:sekret@db.invalid:5432/appdb',
};

describe('db:reset', () => {
  it('rejects SETUP_ENV=local and points at docker compose down -v', () => {
    const res = runScript({ SETUP_ENV: 'local' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/docker compose down -v/);
  });

  it('rejects a missing SETUP_ENV', () => {
    const res = runScript({ SETUP_ENV: undefined });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/dev|qa/i);
  });

  it('fails clearly when MIGRATIONS_DATABASE_URL is missing', () => {
    const res = runScript({ SETUP_ENV: 'dev', MIGRATIONS_DATABASE_URL: undefined });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/MIGRATIONS_DATABASE_URL/);
  });

  it('prints masked URL + db name and aborts on mismatched input', () => {
    const res = runScript(MIGRATIONS_ENV, 'not-the-db-name\n');
    const output = res.stdout + res.stderr;
    expect(output).toContain('miguser:****@db.invalid');
    expect(output).toContain('appdb');
    expect(output).not.toContain('sekret');
    expect(output).toMatch(/abort/i);
    expect(res.status).not.toBe(0);
  });

  it('proceeds past the confirmation gate when the exact db name is typed', () => {
    const res = runScript(MIGRATIONS_ENV, 'appdb\n');
    const output = res.stdout + res.stderr;
    expect(output).not.toMatch(/abort/i);
    // db.invalid is unreachable — the gate passed, the connection fails.
    expect(output).toMatch(/reset|schema|connect/i);
    expect(res.status).not.toBe(0);
  });
});
