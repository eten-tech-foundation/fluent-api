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
