import { describe, expect, it } from 'vitest';

import { getPostgresConstraintName, hasPostgresErrorCode } from './db-errors';

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

describe('getPostgresConstraintName', () => {
  it('reads constraint from node-pg style errors through causes', () => {
    const error = new Error('query failed', {
      cause: {
        code: '23503',
        constraint: 'verse_audio_takes_storage_object_id_storage_objects_id_fk',
      },
    });

    expect(getPostgresConstraintName(error)).toBe(
      'verse_audio_takes_storage_object_id_storage_objects_id_fk'
    );
  });

  it('also accepts constraint_name', () => {
    const error = { cause: { constraint_name: 'users_email_unique' } };

    expect(getPostgresConstraintName(error)).toBe('users_email_unique');
  });
});
