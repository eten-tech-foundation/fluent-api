import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import type { CreateUserInput, UserResponse } from '@/domains/users/users.types';
import type { Result } from '@/lib/types';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { createUser, deleteUser } from '@/domains/users/users.service';
import env from '@/env';
import { auth } from '@/lib/auth';
import { ErrorCode } from '@/lib/types';

export interface UserInvitationResult {
  user: UserResponse;
}

/**
 * Creates a user in the local database and sends a BetterAuth magic link invitation.
 * Uses direct DB insertion for identity and forwards headers to Magic Link API.
 */
export async function createUserWithInvitation(
  input: CreateUserInput,
  headers: Headers
): Promise<Result<UserInvitationResult>> {
  const normalizedInput = { ...input, email: input.email.toLowerCase() };
  const authUserId = crypto.randomUUID();

  try {
    // 1. Create the BetterAuth identity directly in the database.
    // This ensures the record exists for the magic link plugin to use.
    await db.insert(schema.authUser).values({
      id: authUserId,
      email: normalizedInput.email,
      name: normalizedInput.username,
      emailVerified: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Database insertion failed';
    return {
      ok: false,
      error: {
        code: ErrorCode.AUTH_ERROR,
        message: `Failed to create auth identity record: ${errorMessage}`,
      },
    };
  }

  // 2. Create user in local database
  const dbResult = await createUser({
    ...normalizedInput,
    authUserId,
  } as any);

  if (!dbResult.ok) {
    // Rollback BetterAuth identity if local DB creation fails
    await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
    return { ok: false, error: dbResult.error };
  }

  try {
    // 3. Send magic link invitation via BetterAuth
    // BetterAuth REQUIRES headers to be passed for security context
    await auth.api.signInMagicLink({
      body: {
        email: normalizedInput.email,
        callbackURL: `${env.FRONTEND_URL}/accept-invitation`,
      },
      headers,
    });

    return {
      ok: true,
      data: { user: dbResult.data },
    };
  } catch (error) {
    // Rollback both records if the invitation email fails to send
    await deleteUser(dbResult.data.id);
    await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));

    const errorMessage = error instanceof Error ? error.message : 'Unknown invitation error';
    return {
      ok: false,
      error: {
        code: ErrorCode.AUTH_ERROR,
        message: `User invitation failed and was rolled back. Reason: ${errorMessage}`,
      },
    };
  }
}
