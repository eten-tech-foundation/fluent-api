import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';

import type { CreateUserInput, UserResponse } from '@/domains/users/users.types';
import type { Result } from '@/lib/types';

import { db } from '@/db';
import * as schema from '@/db/schema';
import { getRoleId, grantRole, inviteUserToOrg } from '@/domains/user-roles/user-roles.service';
import { createUserWithAuth, deleteUser } from '@/domains/users/users.service';
import env from '@/env';
import { auth } from '@/lib/auth';
import { ROLES } from '@/lib/roles';
import { sendExistingUserOrgInviteEmail } from '@/lib/services/notifications/mailgun.service';
import { ErrorCode } from '@/lib/types';

export interface UserInvitationResult {
  user: UserResponse;
}

/** Extended input that carries the grant fields for the new user's initial role. */
export interface InviteUserInput extends CreateUserInput {
  orgId: number;
  projectId?: number | null;
  roleName?: string;
}

/**
 * Creates a user in the local database, grants them an initial role, and sends
 * a BetterAuth magic link invitation.
 */
export async function createUserWithInvitation(
  input: InviteUserInput,
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
  const dbResult = await createUserWithAuth({
    ...normalizedInput,
    authUserId,
  });

  if (!dbResult.ok) {
    // Rollback BetterAuth identity if local DB creation fails
    await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
    return { ok: false, error: dbResult.error };
  }

  // 3. Grant the new user their initial role via user_roles
  try {
    const roleName = normalizedInput.roleName || ROLES.PROJECT_TRANSLATOR;

    if (
      !normalizedInput.projectId &&
      [ROLES.PROJECT_TRANSLATOR, ROLES.PROJECT_OBSERVER].includes(roleName as any)
    ) {
      await db.delete(schema.users).where(eq(schema.users.id, dbResult.data.id));
      await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
      return {
        ok: false,
        error: {
          code: ErrorCode.VALIDATION_ERROR,
          message: `${roleName} role requires a specific projectId.`,
        },
      };
    }

    const roleId = await getRoleId(roleName);

    const scopedOrgId = roleName === ROLES.SUPER_ADMIN ? null : normalizedInput.orgId;
    const scopedProjectId =
      roleName === ROLES.SUPER_ADMIN ? null : (normalizedInput.projectId ?? null);


    await inviteUserToOrg(dbResult.data.id, scopedOrgId!, dbResult.data.createdBy ?? null);

    const grantResult = await grantRole({
      userId: dbResult.data.id,
      orgId: scopedOrgId,
      projectId: scopedProjectId,
      roleId,
      createdBy: dbResult.data.createdBy ?? null,
    });

    if (!grantResult.ok) {
      // Rollback both local user and auth identity
      await db.delete(schema.users).where(eq(schema.users.id, dbResult.data.id));
      await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
      return {
        ok: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: `Failed to create initial role grant: ${grantResult.error.message}`,
        },
      };
    }
  } catch (error) {
    // Rollback both local user and auth identity
    await db.delete(schema.users).where(eq(schema.users.id, dbResult.data.id));
    await db.delete(schema.authUser).where(eq(schema.authUser.id, authUserId));
    const errorMessage = error instanceof Error ? error.message : 'Grant failed';
    return {
      ok: false,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: `Failed to create initial role grant: ${errorMessage}`,
      },
    };
  }

  try {
    // 4. Send magic link invitation via BetterAuth.
    type AuthAPI = typeof auth;
    await (auth as AuthAPI).api.signInMagicLink({
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

export interface ExistingUserInviteInput {
  existingUser: UserResponse;
  orgId: number;
  projectId?: number | null;
  roleName?: string;
  createdBy: number;
  orgName?: string | null;
  inviterName?: string | null;
}

export async function inviteExistingUserToOrg(
  input: ExistingUserInviteInput
): Promise<Result<UserInvitationResult>> {
  const { existingUser, orgId, projectId, roleName, createdBy, orgName, inviterName } = input;

  try {
    const resolvedRoleName = roleName || ROLES.PROJECT_TRANSLATOR;
    const roleId = await getRoleId(resolvedRoleName);

    // 1. Anchor row — marks org membership with zero-permission Org Member role
    await inviteUserToOrg(existingUser.id, orgId, createdBy);

    // 2. Project-scoped grant — gives actual permissions for this project
    const grantResult = await grantRole({
      userId: existingUser.id,
      orgId,
      projectId: projectId ?? null,
      roleId,
      createdBy,
    });

    if (!grantResult.ok) {
      return {
        ok: false,
        error: {
          code: ErrorCode.INTERNAL_ERROR,
          message: `Failed to grant project role: ${grantResult.error.message}`,
        },
      };
    }

    // 3. Send login-link email (same card style as magic link, no token)
    await sendExistingUserOrgInviteEmail({
      email: existingUser.email,
      firstName: existingUser.username,
      inviterName: inviterName ?? null,
      orgName: orgName ?? null,
      loginUrl: `${env.FRONTEND_URL}/login`,
    });

    return { ok: true, data: { user: existingUser } };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      ok: false,
      error: { code: ErrorCode.INTERNAL_ERROR, message },
    };
  }
}
