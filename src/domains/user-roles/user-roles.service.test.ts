import { beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db';
import { ErrorCode } from '@/lib/types';

import { inviteUserToOrg } from './user-roles.service';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@/lib/db-errors', () => ({
  handleConstraintError: vi.fn((error: unknown) => ({
    ok: false,
    error: { code: ErrorCode.CONFLICT, message: String(error) },
  })),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('inviteUserToOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates an Org Member anchor row for the given user + org', async () => {
    // getRoleId lookup — returns Org Member role id = 7
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 7 }]),
        }),
      }),
    });

    // grantRole pre-check (no existing row) + insert
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const result = await inviteUserToOrg(42, 2, 59);

    expect(result.ok).toBe(true);
  });

  it('is idempotent — succeeds even if called repeatedly', async () => {
    // getRoleId returns id 7
    (db.select as any).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: 7 }]),
        }),
      }),
    });

    // grantRole uses onConflictDoNothing — INSERT is always attempted; DB silently ignores duplicates
    (db.insert as any).mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      }),
    });

    const result1 = await inviteUserToOrg(42, 2, 59);
    const result2 = await inviteUserToOrg(42, 2, 59);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    expect(db.insert).toHaveBeenCalledTimes(2);
  });
});
