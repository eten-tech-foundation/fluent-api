import { hashPassword } from 'better-auth/crypto';
import { and, eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import { db } from '@/db';
import { authAccount, authUser, users } from '@/db/schema';

export interface ReconcileSeedUserInput {
  email: string;
  username: string;
  /** Plaintext — hashed at seed time. */
  password?: string;
  /** Committed better-auth hash — written directly, no hashing. */
  passwordHash?: string;
  firstName?: string;
  lastName?: string;
  /** users.createdBy — the actor creating this account (null for self/first). */
  createdBy: number | null;
}

/**
 * Shared user writer used by the demo seed engine: create or reconcile the
 * auth_user + auth_account + users triple for one seed account. Accepts a
 * plaintext password (hashed at seed time) or a committed better-auth hash
 * (written verbatim).
 *
 * Returns the application `users.id`, or null when the row was skipped
 * (username taken by a different account, or auth_user exists without a
 * matching users row).
 */
export async function reconcileSeedUser(
  input: ReconcileSeedUserInput
): Promise<number | null> {
  if (!input.password && !input.passwordHash) {
    throw new Error(`Seed user ${input.email} has neither password nor passwordHash.`);
  }
  const hashedPassword = input.passwordHash ?? (await hashPassword(input.password!));
  const authUserId = crypto.randomUUID();

  let appUserId: number | null = null;

  await db.transaction(async (tx) => {
    // ── Resolve existing account or create a new one ─────────────────────
    const [existingAuthUser] = await tx
      .select({ id: authUser.id })
      .from(authUser)
      .where(eq(authUser.email, input.email))
      .limit(1);

    const [existingUserByEmail] = await tx
      .select({ id: users.id, authUserId: users.authUserId })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    const [existingUserByUsername] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, input.username))
      .limit(1);

    if (existingAuthUser || existingUserByEmail) {
      // Account already exists — the email-keyed users row is the one to reconcile.
      const resolvedAppUser = existingUserByEmail;

      if (!resolvedAppUser) {
        console.log(`Skipping ${input.email} — auth_user exists but no matching users row.`);
        return;
      }

      appUserId = resolvedAppUser.id;
      const targetAuthUserId = existingAuthUser?.id ?? resolvedAppUser.authUserId;

      // Password rotation: update stored password hash on reconcile
      if (targetAuthUserId) {
        await tx
          .update(authAccount)
          .set({
            password: hashedPassword,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(authAccount.userId, targetAuthUserId),
              eq(authAccount.providerId, 'credential')
            )
          );
      }

      console.log(`User ${input.email} reconciled (roles & password updated).`);
    } else if (existingUserByUsername) {
      console.log(`Skipping ${input.username} — username already taken by a different user.`);
    } else {
      // Create new account.
      await tx.insert(authUser).values({
        id: authUserId,
        email: input.email,
        name: input.username,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await tx.insert(authAccount).values({
        id: crypto.randomUUID(),
        userId: authUserId,
        accountId: input.email,
        providerId: 'credential',
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const [newUser] = await tx
        .insert(users)
        .values({
          username: input.username,
          email: input.email,
          firstName: input.firstName ?? input.username,
          lastName: input.lastName ?? null,
          status: 'verified',
          authUserId,
          createdBy: input.createdBy,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning({ id: users.id });

      appUserId = newUser.id;
      console.log(`Created user: ${input.email}`);
    }
  });

  return appUserId;
}
