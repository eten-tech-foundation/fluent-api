import { verifyPassword } from 'better-auth/crypto';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const SCRIPT = 'src/db/scripts/hash-password.ts';
const PASSWORD = 'test-password-123';

function runScript(args: string[]) {
  return spawnSync('npx', ['tsx', SCRIPT, ...args], { encoding: 'utf-8', timeout: 30_000 });
}

describe('db:hash-password', () => {
  it('prints a better-auth hash that verifyPassword accepts', async () => {
    const res = runScript([PASSWORD]);
    expect(res.status).toBe(0);
    const hash = res.stdout.trim();
    expect(hash.length).toBeGreaterThan(0);
    expect(await verifyPassword({ hash, password: PASSWORD })).toBe(true);
    expect(await verifyPassword({ hash, password: 'wrong-password' })).toBe(false);
  });

  it('prints usage and exits non-zero when no password is given', () => {
    const res = runScript([]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage/i);
  });
});
