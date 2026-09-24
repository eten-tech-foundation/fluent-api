# Migrate Transactional Email: Mailgun → Cloudflare

Plan for [#234](https://github.com/eten-tech-foundation/fluent-api/issues/234).
Branch: `task/migrate-email-to-cloudflare`.

## Addresses

| Address                | Meaning                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `noreply@fluent.bible` | Sender/from address for all transactional email. Also receives replies — aliased to `support@fluent.bible` at the mail host.                     |
| `help@fluent.bible`    | Public contact address — aliased to `support@fluent.bible` at the mail host.                                                                   |
| `support@fluent.bible` | Human-read inbox, hosted at an external mail provider (Google Workspace / M365 / etc. — provider provisioning is a manual step below).          |

## Current state (audit)

All outbound email flows through `src/lib/services/notifications/mailgun.service.ts`
(`mailgun.js` v12.0.3, `https://api.mailgun.net`):

| Send site                              | Caller                                                                                                      | Shape                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `sendEmail({to, subject, html})`       | BetterAuth hooks in `src/lib/auth.ts` — password reset (line ~69), 2FA OTP (~135), magic-link invite (~154) | Inline HTML, log-and-continue on error                               |
| `sendExistingUserOrgInviteEmail(data)` | `src/lib/services/auth/auth.service.ts:205`                                                                 | Inline HTML, delegates to `sendEmail`                                |
| `sendInvitationEmail(...)`             | **none — dead code**                                                                                        | Uses Mailgun-hosted template `'user invite'` + `X-Mailgun-Variables` |

Config: `EMAIL_SERVICE_API_KEY`, `EMAIL_SERVICE_DOMAIN`, `EMAIL_SERVICE_SENDER` —
all required in `src/env.ts` (boot fails if unset). Deployed values live in Azure
App Service settings, outside this repo. `compose.yaml`, Docker, and workflows
reference none of them.

## Settled decisions

- **Transport: Cloudflare Email Service REST API** — `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`, `Authorization: Bearer <token>`. No new dependency (native `fetch`, same convention as `callFluentAi`). The Workers binding is not an option — fluent-api is a Node app on Azure. SMTP rejected: would add a dependency for no benefit.
- **`sendInvitationEmail` is deleted, not ported.** Zero callers; it's the only Mailgun-template user, so no hosted-template replacement is needed on Cloudflare. Flag in the PR so a reviewer can confirm it's dead. The `'user invite'` template dies with the Mailgun account.
- **Env names stay provider-agnostic:** `EMAIL_SERVICE_API_TOKEN` + `EMAIL_SERVICE_ACCOUNT_ID` + `EMAIL_SERVICE_SENDER`. `EMAIL_SERVICE_API_KEY` and `EMAIL_SERVICE_DOMAIN` are removed (Cloudflare infers the domain from the sender address + onboarded domains on the account).
- **Inbound mail = mail-host aliases, NOT Cloudflare Email Routing.** `support@fluent.bible` will be a real hosted mailbox, so MX for `fluent.bible` belongs to that mail host — **do not onboard Email Routing for the root domain** (it would hijack inbound mail headed for the hosted inbox). `noreply@` and `help@` are aliases → `support@` configured at the mail host. No Email Worker.
- **`fluent.bible` is already on Cloudflare DNS** (hard prerequisite — satisfied). One onboarded domain, one sender address across dev/qa/prod; **separate API tokens per env** for blast-radius control.
- **Deliverable: this plan only** — #234 is the ticket; no ADR (rationale lives here and in the issue).

## Manual prerequisites (human)

These cannot be done from code. Order matters: DNS must exist before verification.

### Email Sending — Cloudflare dashboard

1. Dashboard → **Compute → Email Service → Email Sending** → **Onboard Domain** → `fluent.bible`.
2. Review the DNS records Cloudflare adds: MX + SPF + DKIM land on the `cf-bounce`
   subdomain (bounce handling — no conflict with the mail host's root MX), plus a
   DMARC TXT on `_dmarc.fluent.bible`.
3. **DNS audit first:** `dig TXT fluent.bible` and `dig TXT _dmarc.fluent.bible` —
   the mail host below will publish its own root SPF (`v=spf1 include:...`) and
   likely a DMARC record. SPF: merge mechanisms into ONE TXT record (two SPF
   records on one hostname break both). DMARC: keep a single `_dmarc` policy —
   reconcile with whatever onboarding wants to add.
4. Create one **API token per env** (dev / qa / prod) with permission
   **Email Sending: Edit** on the account. Store per-env in Azure App Service
   settings; dev token in local `.env`.

### Inbound mail — mail host (NOT Cloudflare Email Routing)

5. Provision the `support@fluent.bible` mailbox at the chosen mail provider.
6. In the Cloudflare **DNS** dashboard, point `fluent.bible` MX records at the
   mail host (values come from the provider). Do **not** onboard Email Routing —
   Cloudflare must not own inbound MX for this domain.
7. At the mail host, create aliases/forwards so both `noreply@fluent.bible` and
   `help@fluent.bible` deliver to the `support@fluent.bible` inbox.
8. Test: send mail to `noreply@fluent.bible` and `help@fluent.bible` from an
   unrelated external account → confirm both arrive in the `support@` inbox.

## Code changes

1. **Rename** `src/lib/services/notifications/mailgun.service.ts` →
   `email.service.ts` (keeps the "notifications" grouping; drops the vendor name
   so the audit grep is honest).
2. **Rewrite `sendEmail({to, subject, html})`** — signature unchanged. `fetch`
   POST to `…/accounts/${EMAIL_SERVICE_ACCOUNT_ID}/email/sending/send` with
   `{from: EMAIL_SERVICE_SENDER, to, subject, html}`. Preserve current semantics:
   missing config → `console.error` + return; request failure or
   `success: false` → `console.error` (include `errors` and `result.permanent_bounces`
   from the response body) + return.
3. **`sendExistingUserOrgInviteEmail`** — unchanged; still delegates to `sendEmail`.
4. **Delete `sendInvitationEmail` + `InvitationEmailData`** (dead code).
5. **Update imports:**
   - `src/lib/auth.ts:13`
   - `src/lib/services/auth/auth.service.ts:13`
   - `src/lib/services/auth/auth.service.test.ts` — `vi.mock` path + import (lines ~4, ~17)
6. **`src/env.ts` (lines ~101–103):** replace `EMAIL_SERVICE_API_KEY` and
   `EMAIL_SERVICE_DOMAIN` with `EMAIL_SERVICE_API_TOKEN` and
   `EMAIL_SERVICE_ACCOUNT_ID`; keep `EMAIL_SERVICE_SENDER`. All remain required
   `z.string()` — fail-fast boot behavior preserved.
7. **`package.json`:** remove `mailgun.js`. No new dependency.

## Config changes

- **`.env.example`** — rewrite the email block:
  ```
  # Email (Cloudflare Email Service) — all three are REQUIRED; the app fails to boot if unset.
  # API token with "Email Sending: Edit" on the account (per-env tokens).
  EMAIL_SERVICE_API_TOKEN=
  # Cloudflare account ID that owns the onboarded sending domain.
  EMAIL_SERVICE_ACCOUNT_ID=
  # From address on the onboarded domain.
  EMAIL_SERVICE_SENDER=noreply@fluent.bible
  ```
- **Azure App Service settings (per env):** add `EMAIL_SERVICE_API_TOKEN`,
  `EMAIL_SERVICE_ACCOUNT_ID`; update `EMAIL_SERVICE_SENDER` to
  `noreply@fluent.bible`; delete `EMAIL_SERVICE_API_KEY` and `EMAIL_SERVICE_DOMAIN`.

## Verification

- **Unit:** update `auth.service.test.ts` mock path; add tests for the new sender
  mocking `fetch` (`vi.spyOn(global, 'fetch')`, same convention as fluent-ai
  tests): success path, non-2xx, `success:false`, missing config.
- **Smoke (manual):** `curl` the REST endpoint with the dev token — expect
  `result.delivered` to contain the recipient.
- **E2E (QA):** trigger a real password reset and a magic-link invite; confirm
  delivery **from `noreply@fluent.bible`** (ticket acceptance criterion).
- **Audit:** `rg -i mailgun` and `rg EMAIL_SERVICE_DOMAIN` → zero hits in code,
  `.env.example`, and docs outside this plan.
- **Inbound:** step 8 of manual prerequisites (`noreply@` + `help@` → `support@`).

## Rollout order

1. Human: provision `support@fluent.bible` mailbox + point `fluent.bible` MX at
   the mail host + create `noreply@`/`help@` aliases (can run in parallel with
   the rest; must exist before prod users start replying).
2. Human: Email Sending onboarding + DNS/SPF/DMARC audit (propagation ~5–15 min,
   up to 24 h).
3. Human: create per-env API tokens; set env vars in dev/QA.
4. Merge code → deploy QA → run E2E verification.
5. Prod env vars → deploy prod → verify a representative email.
6. **Cleanup:** remove Mailgun DNS records (the old `mg.*`/mailgun TXT/MX on
   `fluent.bible` if present — the inbound MX now belongs to the mail host),
   revoke the Mailgun API key, close the personal Mailgun account once prod is
   confirmed.

## Out of scope

- Email content/template redesign; adding `text/plain` bodies (Cloudflare
  accepts `text`, current emails are HTML-only — preserve behavior).
- New transactional email types; marketing/bulk email.
- Choosing/provisioning the mail host for `support@fluent.bible` (manual step).
- Inbound mail processing beyond mail-host aliases (no Email Worker; Cloudflare
  Email Routing is deliberately not used — see settled decisions).
