import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { bearer, magicLink, twoFactor } from 'better-auth/plugins';
import { admin } from 'better-auth/plugins/admin';

import { db } from '@/db';
import * as schema from '@/db/schema';
import env from '@/env';
import { logger } from '@/lib/logger';
import { sendEmail } from '@/lib/services/notifications/mailgun.service';

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      // Map BetterAuth model names → our Drizzle table exports
      user: schema.authUser,
      session: schema.authSession,
      account: schema.authAccount,
      verification: schema.authVerification,
    },
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.FRONTEND_URL],

  // ─── Email/Password ─────────────────────────────────────────────
  emailAndPassword: {
    enabled: true,
    async sendResetPassword({ user, url }) {
      await sendEmail({
        to: user.email,
        subject: 'Reset Your Fluent Password',
        html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; border-radius: 12px;">
              <div style="background: linear-gradient(135deg, #0052cc 0%, #0071ff 100%); padding: 40px; text-align: center; color: white; border-radius: 8px 8px 0 0;">
                <h1 style="margin: 0; font-size: 32px;">Password Reset</h1>
              </div>
              <div style="padding: 40px; background: white; border-radius: 0 0 8px 8px;">
                <p style="font-size: 18px; color: #374151;">Hello,</p>
                <p style="font-size: 16px; color: #4b5563; line-height: 1.5;">We received a request to reset your password for your Fluent account. Click the button below to choose a new password.</p>
                <div style="text-align: center; margin: 40px 0;">
                  <a href="${url.replace(`${env.BETTER_AUTH_URL}/reset-password/`, `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=`).replace(/\?token=([^&]+)\?/, '?token=$1&')}" style="background-color: #0052cc; color: white; padding: 16px 32px; text-decoration: none; border-radius: 6px; font-weight: bold; font-size: 16px; display: inline-block;">Reset Password</a>
                </div>
                <p style="font-size: 14px; color: #6b7280;">If you didn't request this, you can safely ignore this email. This link will expire in 1 hour.</p>
                <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 30px 0;" />
                <p style="font-size: 12px; color: #9ca3af; text-align: center;">&copy; ${new Date().getFullYear()} Fluent. All rights reserved.</p>
              </div>
            </div>
          `,
      });
    },
  },

  // ─── Session Config ──────────────────────────────────────────────
  session: {
    expiresIn: env.BETTER_AUTH_SESSION_EXPIRY_SECONDS,
    updateAge: Math.floor(env.BETTER_AUTH_SESSION_EXPIRY_SECONDS / 7), // refresh ~daily relative to expiry
    cookieCache: { enabled: true, maxAge: 300 },
  },

  // ─── Cross-Domain Cookies ────────────────────────────────────────
  advanced: {
    crossSubDomainCookies: {
      enabled: env.NODE_ENV === 'production',
      domain: env.BETTER_AUTH_COOKIE_DOMAIN,
    },
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      httpOnly: true,
    },
  },

  // ─── Rate Limiting (built-in) ────────────────────────────────────
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      '/api/auth/sign-in': { window: 60, max: 5 },
      '/api/auth/sign-up': { window: 60, max: 3 },
      '/api/auth/forget-password': { window: 60, max: 3 },
    },
  },

  // ─── Plugins ─────────────────────────────────────────────────────
  plugins: [
    // Admin API (for server-side user management)
    admin(),

    // TOTP 2FA + email OTP backup
    twoFactor({
      otpOptions: {
        async sendOTP({ user, otp }) {
          await sendEmail({
            to: user.email,
            subject: 'Your Fluent verification code',
            html: `<p>Your verification code is: <strong>${otp}</strong></p><p>This code expires in 5 minutes.</p>`,
          });
        },
      },
    }),

    // WebAuthn/Passkeys
    passkey({
      rpID: env.NODE_ENV === 'production' ? 'fluent.bible' : 'localhost',
      rpName: 'Fluent',
      origin: env.FRONTEND_URL,
    }),

    // Magic links (for user invitations)
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await sendEmail({
          to: email,
          subject: 'Welcome to Fluent!',
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e5e7eb; rounded: 12px;">
              <div style="background: linear-gradient(135deg, #6366f1 0%, #a855f7 100%); padding: 40px; text-align: center; color: white; border-radius: 8px 8px 0 0;">
                <h1 style="margin: 0; font-size: 32px;">Welcome to Fluent!</h1>
              </div>
              <div style="padding: 40px; background: white; border-radius: 0 0 8px 8px;">
                <p style="font-size: 18px; color: #374151;">You've been invited to join Fluent! To get started, please set up your password by clicking the button below.</p>
                <div style="text-align: center; margin: 40px 0;">
                  <a href="${url}" style="background: #6366f1; color: white; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 18px; display: inline-block;">Set Up Your Password</a>
                </div>
                <p style="color: #6b7280; font-size: 14px;">If the button doesn't work, you can also copy and paste this link into your browser:</p>
                <p style="background: #f3f4f6; padding: 12px; border-radius: 4px; word-break: break-all; font-family: monospace; font-size: 12px; color: #374151;">${url}</p>
                <hr style="border: 0; border-top: 1px solid #e5e7eb; margin: 40px 0;" />
                <p style="color: #6b7280; font-size: 12px; text-align: center;">Important: This invitation link will expire in 7 days for security reasons.</p>
              </div>
            </div>
          `,
        });
      },
      expiresIn: 604800, // 7 days for invitations
    }),

    // Bearer tokens (for mobile clients)
    bearer(),
  ],

  // ─── Audit Logging via databaseHooks ─────────────────────────────
  databaseHooks: {
    session: {
      create: {
        after: async (session) => {
          try {
            await db.insert(schema.authAuditLog).values({
              userId: session.userId,
              event: 'session.created',
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
              metadata: { sessionId: session.id },
            });
          } catch (error) {
            logger.error('Failed to log audit event: session.created', { error });
          }
        },
      },
      delete: {
        after: async (session) => {
          try {
            await db.insert(schema.authAuditLog).values({
              userId: session.userId,
              event: 'session.deleted',
              ipAddress: session.ipAddress ?? null,
              userAgent: session.userAgent ?? null,
              metadata: { sessionId: session.id },
            });
          } catch (error) {
            logger.error('Failed to log audit event: session.deleted', { error });
          }
        },
      },
    },
    user: {
      create: {
        after: async (user) => {
          try {
            await db.insert(schema.authAuditLog).values({
              userId: user.id,
              event: 'user.created',
              metadata: { email: user.email },
            });
          } catch (error) {
            logger.error('Failed to log audit event: user.created', { error });
          }
        },
      },
    },
    verification: {
      create: {
        after: async (verification) => {
          try {
            await db.insert(schema.authAuditLog).values({
              event: 'verification.created',
              metadata: { identifier: verification.identifier, value: '***' },
            });
          } catch (error) {
            logger.error('Failed to log audit event: verification.created', { error });
          }
        },
      },
    },
  },
});
