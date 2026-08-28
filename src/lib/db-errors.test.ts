import { describe, expect, it } from 'vitest';

import { hasPostgresErrorCode } from './db-errors';

describe('hasPostgresErrorCode', () => {
  it('finds a driver code through wrapped causes', () => {
    const error = new Error('query failed', {
      cause: new Error('transaction failed', { cause: { code: '23503' } }),
    });

    expect(hasPostgresErrorCode(error, '23503')).toBe(true);
  });

  it('returns false for unrelated errors and cyclic causes', () => {
    const error: Error & { cause?: unknown } = new Error('query failed');
    error.cause = error;

    expect(hasPostgresErrorCode(error, '23503')).toBe(false);
    expect(hasPostgresErrorCode(null, '23503')).toBe(false);
  });
});
