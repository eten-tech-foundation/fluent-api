import { ManagementClient } from 'auth0';
import { randomBytes } from 'node:crypto';

import type { CreateUserInput, User } from '@/domains/users/users.types';
import type { Result } from '@/lib/types';

import { createUser, deleteUser } from '@/domains/users/users.service';
import env from '@/env';
import { sendInvitationEmail } from '@/lib/services/notifications/mailgun.service';
import { ErrorCode } from '@/lib/types';

const management = new ManagementClient({
  domain: env.AUTH0_DOMAIN,
  clientId: env.AUTH0_M2M_CLIENT_ID,
  clientSecret: env.AUTH0_M2M_CLIENT_SECRET,
});

export default management;

export interface UserInvitationResult {
  user: User;
  auth0_user_id: string;
  ticket_url: string;
}

export async function createUserWithInvitation(
  input: CreateUserInput
): Promise<Result<UserInvitationResult>> {
  const normalizedInput = { ...input, email: input.email.toLowerCase() };

  // 1. Create user in local database using handler
  const dbResult = await createUser(normalizedInput);
  if (!dbResult.ok) {
    return { ok: false, error: dbResult.error };
  }

  try {
    // 2. Create user in Auth0
    const auth0User = await createAuth0User(normalizedInput);

    // 3. Create password change ticket (invitation link)
    const ticketUrl = await createPasswordChangeTicket(auth0User.user_id!);

    // 4. Send invitation email
    await sendUserInvitationEmail(normalizedInput, ticketUrl);

    return {
      ok: true,
      data: {
        user: dbResult.data,
        auth0_user_id: auth0User.user_id!,
        ticket_url: ticketUrl,
      },
    };
  } catch (error) {
    // Rollback: Delete user from database if Auth0 operations fail
    await deleteUser(dbResult.data.id);

    const errorMessage = error instanceof Error ? error.message : 'Unknown Auth0 error';
    return {
      ok: false,
      error: {
        code: ErrorCode.AUTH0_ERROR,
        message: `User creation failed during Auth0 sync and was rolled back. Reason: ${errorMessage}`,
      },
    };
  }
}

export async function sendInvitationToExistingUser(
  userId: string,
  email: string,
  firstName?: string,
  lastName?: string
): Promise<Result<{ ticket_url: string }>> {
  try {
    const lowercaseEmail = email.toLowerCase();
    const ticketUrl = await createPasswordChangeTicket(userId);

    await sendUserInvitationEmail(
      { email: lowercaseEmail, firstName: firstName ?? null, lastName: lastName ?? null },
      ticketUrl
    );

    return {
      ok: true,
      data: { ticket_url: ticketUrl },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: ErrorCode.AUTH0_ERROR,
        message: error instanceof Error ? error.message : 'Failed to send invitation',
      },
    };
  }
}

async function createAuth0User(input: CreateUserInput) {
  const auth0User = await management.users.create({
    email: input.email,
    name: input.username,
    connection: 'Username-Password-Authentication',
    email_verified: false,
    password: generateTemporaryPassword(),
    verify_email: false,
  });

  if (!auth0User.data.user_id) {
    throw new Error('Auth0 user creation did not return a user_id.');
  }

  return auth0User.data;
}

async function createPasswordChangeTicket(userId: string): Promise<string> {
  const ticket = await management.tickets.changePassword({
    user_id: userId,
    mark_email_as_verified: true,
    ttl_sec: 604800, // 7 days
    includeEmailInRedirect: false,
    result_url: process.env.FRONTEND_URL,
  });

  if (!ticket.data.ticket) {
    throw new Error('Failed to generate password change ticket.');
  }

  return ticket.data.ticket;
}

async function sendUserInvitationEmail(
  input: Pick<CreateUserInput, 'email' | 'firstName' | 'lastName'>,
  ticketUrl: string
): Promise<void> {
  const emailResult = await sendInvitationEmail({
    email: input.email,
    ticketUrl,
    firstName: input.firstName ?? undefined,
    lastName: input.lastName ?? undefined,
  });

  if (!emailResult.ok) {
    console.error('Failed to send invitation email:', emailResult.error.message);
  }
}

function generateTemporaryPassword(): string {
  return randomBytes(16).toString('base64').slice(0, 16);
}
