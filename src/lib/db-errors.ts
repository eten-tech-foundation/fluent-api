import type { Result } from '@/lib/types';

import { err, ErrorCode } from '@/lib/types';

/**
 * Maps generic Postgres constraint violations to standard ErrorCode responses.
 */
export function handleConstraintError(
  error: unknown,
  fallback: ErrorCode = ErrorCode.INTERNAL_ERROR
): Result<never> {
  if (error && typeof error === 'object' && 'cause' in error) {
    const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;

    // Unique violation
    if (cause?.code === '23505') {
      const constraint = cause.constraint_name ?? '';
      if (constraint.includes('username')) return err(ErrorCode.USERNAME_CONFLICT);
      if (constraint.includes('email')) return err(ErrorCode.EMAIL_CONFLICT);
      return err(ErrorCode.DUPLICATE);
    }

    // Foreign key violation
    if (cause?.code === '23503') {
      return err(ErrorCode.INVALID_REFERENCE);
    }
  }
  return err(fallback);
}
