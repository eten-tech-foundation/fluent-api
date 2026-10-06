import { verifyPassword } from 'better-auth/crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'src/db/scripts/hash-password.ts';
const PASSWORD = 'test-password-123';

function runScript(input: string, args: string[] = []) {
  return spawnSync('npx', ['tsx', SCRIPT, ...args], {
    input,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('db:hash-password', () => {
  it(
    'prints a better-auth hash that verifyPassword accepts (stdin input)',
    async () => {
      const res = runScript(`${PASSWORD}\n`);
      expect(res.status).toBe(0);
      const hash = res.stdout.trim();
      expect(hash.length).toBeGreaterThan(0);
      expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
      expect(await verifyPassword({ hash, password: 'wrong-password' })).toBe(false);
    },
    30_000
  );

  it(
    'refuses a password passed via argv (shell history / process list)',
    () => {
      const res = runScript('', [PASSWORD]);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/stdin/i);
      expect(res.stdout.trim()).toBe('');
    },
    30_000
  );

  it(
    'prints usage and exits non-zero when stdin is empty',
    () => {
      const res = runScript('');
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/usage/i);
    },
    30_000
  );
});
