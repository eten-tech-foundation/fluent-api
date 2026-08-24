import Mailgun from 'mailgun.js';

import type { Result } from '@/lib/types';

import { ErrorCode } from '@/lib/types';

const mailgun = new Mailgun(FormData);

const mg = mailgun.client({
  username: 'api',
  key: process.env.EMAIL_SERVICE_API_KEY!,
  url: 'https://api.mailgun.net',
});

export interface InvitationEmailData {
  email: string;
  ticketUrl: string;
  firstName?: string;
  lastName?: string;
}

export async function sendInvitationEmail({
  email,
  ticketUrl,
  firstName,
  lastName,
}: InvitationEmailData): Promise<Result<{ messageId?: string }>> {
  if (!process.env.EMAIL_SERVICE_API_KEY) {
    return {
      ok: false,
      error: {
        code: ErrorCode.EMAIL_SERVICE_ERROR,
        message: 'Email service API key is not configured',
      },
    };
  }

  if (!process.env.EMAIL_SERVICE_DOMAIN) {
    return {
      ok: false,
      error: {
        code: ErrorCode.EMAIL_SERVICE_ERROR,
        message: 'Email service domain is not configured',
      },
    };
  }

  if (!process.env.EMAIL_SERVICE_SENDER) {
    return {
      ok: false,
      error: {
        code: ErrorCode.EMAIL_SERVICE_ERROR,
        message: 'Email service sender is not configured',
      },
    };
  }

  try {
    const userName =
      firstName && lastName ? `${firstName} ${lastName}`.trim() : firstName || lastName || '';
    const templateVariables = {
      recipientName: userName,
      invitationUrl: ticketUrl,
    };

    const emailData = {
      from: process.env.EMAIL_SERVICE_SENDER,
      to: email,
      subject: 'Welcome! Complete Your Account Setup',
      template: 'user invite',
      'h:X-Mailgun-Variables': JSON.stringify(templateVariables),
    };

    const response = await mg.messages.create(process.env.EMAIL_SERVICE_DOMAIN!, emailData);

    return {
      ok: true,
      data: { messageId: response.id },
    };
  } catch (error) {
    console.error('Full error object:', error);
    return {
      ok: false,
      error: {
        code: ErrorCode.EMAIL_SERVICE_ERROR,
        message: error instanceof Error ? error.message : 'Unknown email error',
      },
    };
  }
}

// ─── Generic email sender (used by BetterAuth plugins) ────────────────────────

export interface GenericEmailData {
  to: string;
  subject: string;
  html: string;
}

export async function sendEmail({ to, subject, html }: GenericEmailData): Promise<void> {
  if (!process.env.EMAIL_SERVICE_API_KEY || !process.env.EMAIL_SERVICE_DOMAIN) {
    console.error('Email service not configured — skipping email send');
    return;
  }

  try {
    await mg.messages.create(process.env.EMAIL_SERVICE_DOMAIN!, {
      from: process.env.EMAIL_SERVICE_SENDER!,
      to,
      subject,
      html,
    });
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

// ─── Existing user org invite email ───────────────────────────────────────────

export interface ExistingUserOrgInviteEmailData {
  email: string;
  firstName?: string | null;
  inviterName?: string | null;
  orgName?: string | null;
  loginUrl: string;
}

export async function sendExistingUserOrgInviteEmail(
  data: ExistingUserOrgInviteEmailData
): Promise<void> {
  const greeting = data.firstName ? `Hi ${data.firstName},` : 'Hi there,';
  const inviterLine = data.inviterName
    ? `${data.inviterName} has added you to`
    : 'You have been added to';
  const orgLabel = data.orgName ? `<strong>${data.orgName}</strong>` : 'an organisation';

  await sendEmail({
    to: data.email,
    subject: `You've been added to ${data.orgName ?? 'Fluent'}`,
    html: `
      <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
        <div style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); padding: 40px; text-align: center; color: white; border-radius: 8px 8px 0 0;">
          <h1 style="margin: 0; font-size: 28px;">You've been added to ${data.orgName ?? 'Fluent'}!</h1>
        </div>
        <div style="padding: 40px; background: white; border-radius: 0 0 8px 8px;">
          <p style="font-size: 18px; color: #374151;">${greeting}</p>
          <p style="font-size: 16px; color: #4b5563; line-height: 1.5;">
            ${inviterLine} ${orgLabel} on Fluent.
            You can log in with your existing account to get started:
          </p>
          <div style="text-align: center; margin: 40px 0;">
            <a href="${data.loginUrl}"
               style="background: #6366f1; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 18px; display: inline-block;">
              Log In
            </a>
          </div>
          <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
          <p style="font-size: 14px; color: #6b7280;">
            If you weren't expecting this, you can safely ignore this email.
          </p>
          <p style="font-size: 12px; color: #9ca3af; text-align: center;">— The Fluent Team</p>
        </div>
      </div>
    `,
  });
}
