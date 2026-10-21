import type { Result } from '@/lib/types';

import { err, ErrorCode } from '@/lib/types';

/** Walks `cause` chains without depending on a driver-specific class. */
function walkErrorChain(error: unknown, visit: (node: object) => boolean): boolean {
  let current = error;
  const visited = new Set<object>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    if (visit(current)) {
      return true;
    }
    current = 'cause' in current ? current.cause : undefined;
  }

  return false;
}

/** Checks a wrapped database error without depending on a driver-specific class. */
export function hasPostgresErrorCode(error: unknown, code: string): boolean {
  return walkErrorChain(error, (node) => 'code' in node && node.code === code);
}

/** Returns the Postgres constraint name from a wrapped driver error, if present. */
export function getPostgresConstraintName(error: unknown): string | undefined {
  let found: string | undefined;
  walkErrorChain(error, (node) => {
    const constraint =
      ('constraint' in node && typeof node.constraint === 'string' && node.constraint) ||
      ('constraint_name' in node &&
        typeof node.constraint_name === 'string' &&
        node.constraint_name) ||
      undefined;
    if (constraint) {
      found = constraint;
      return true;
    }
    return false;
  });
  return found;
}

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
