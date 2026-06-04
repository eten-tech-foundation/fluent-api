#!/usr/bin/env -S npx tsx
/**
 * Manual smoke test for `POST /ai/tools/greek-room/repeated-words` on fluent-api.
 *
 * Mirrors fluent-ai's `scripts/smoke_repeated_words.py`, but probes the
 * fluent-api proxy endpoint (which in turn calls fluent-ai). It hits the
 * running fluent-api service over real HTTP with the same canned 3-verse
 * corpus that exercises:
 *
 *   - one verse with a suspicious duplicate ("In in the beginning ...")
 *   - one verse with a legitimate duplicate ("Truly, truly, I say unto thee.")
 *   - one clean verse with no duplicates
 *
 * It is a thin "does the deployed proxy respond correctly" probe, NOT a
 * substitute for the vitest suite. It requires BOTH fluent-api and fluent-ai
 * to be up (ecosystem mode, or standalone with fluent-ai started separately).
 *
 * Prerequisites for a from-scratch stack:
 *   A fresh `./fluent.sh up` runs fluent-api's docker-entrypoint.sh, which
 *   migrates the DB and seeds roles + RBAC — but it does NOT seed the default
 *   organization or the dev login users (those are deliberately kept out of
 *   automatic boot so production images never auto-provision accounts). This
 *   script signs in as a seeded dev user, so on a brand-new stack you must
 *   seed the org + dev users once (order matters — org before users). Run them
 *   against the already-running `api` container with `docker compose exec` (the
 *   platform's own db:seed helper uses the same `exec` form):
 *
 *     Ecosystem mode (from fluent-platform/):
 *       docker compose exec api npx tsx src/db/seeds/organizations.ts
 *       docker compose exec api npx tsx src/db/seeds/dev-users.ts
 *
 *     Standalone / inside the api container (from fluent-api/):
 *       npm run db:seed:org
 *       npm run db:seed:dev-users
 *
 *   That creates "Fluent Dev" plus pm@fluent.local and t@fluent.local. If you
 *   skip this step, sign-in returns 401 and the script prints the same hint.
 *
 * Because the fluent-api endpoint is guarded by a BetterAuth session +
 * AI_TOOLS_USE permission, the script needs a session credential. There are
 * three ways to supply one, in priority order:
 *
 *   1. A bearer token you already have (mobile / API client):
 *      npm run smoke:repeated-words -- --token "<better-auth-bearer-token>"
 *      # (or set FLUENT_API_TOKEN in the environment)
 *
 *   2. A raw Cookie header (web session):
 *      npm run smoke:repeated-words -- --cookie "better-auth.session_token=..."
 *
 *   3. Nothing — the script auto-signs-in with a seeded dev user and captures
 *      the bearer token from the BetterAuth `set-auth-token` response header.
 *      Defaults to the seeded translator (t@fluent.local / t@123456), which
 *      carries the content:update permission that AI_TOOLS_USE aliases.
 *      Override with --signin-email / --signin-password (or the env vars
 *      FLUENT_API_SIGNIN_EMAIL / FLUENT_API_SIGNIN_PASSWORD):
 *      npm run smoke:repeated-words -- --signin-email pm@fluent.local \
 *                                       --signin-password pm@123456
 *
 * The base URL defaults to $FLUENT_API_URL or http://localhost:9999 (which
 * works both on the host — published port — and inside the api container —
 * loopback). From a *different* container, pass --url http://api:9999.
 *
 *   # Override the base URL:
 *   npm run smoke:repeated-words -- --url http://localhost:9999
 *
 *   # Print the raw response body and skip sanity checks:
 *   npm run smoke:repeated-words -- --raw
 *
 * Exit status:
 *   0 — request succeeded and (unless --raw) all sanity checks passed
 *   1 — HTTP error, unexpected response shape, failed sanity check, or
 *       sign-in failure
 *   2 — bad CLI arguments
 */

/* eslint-disable no-console */

interface VerseInput {
  snt_id: string;
  text: string;
}

interface SampleRequest {
  lang_code: string;
  lang_name: string;
  project_id: string | number;
  project_name: string;
  verses: VerseInput[];
}

// Must stay in sync with fluent-ai/tests/api/v1/test_greek_room.py so that
// "what passes in pytest" and "what this script sends" agree.
const SAMPLE_REQUEST: SampleRequest = {
  lang_code: 'eng',
  lang_name: 'English',
  project_id: 'smoke-test',
  project_name: 'Smoke Test',
  verses: [
    { snt_id: 'GEN 1:1', text: 'In in the beginning God created the heavens.' },
    { snt_id: 'JHN 3:3', text: 'Truly, truly, I say unto thee.' },
    { snt_id: 'PSA 23:1', text: 'The Lord is my shepherd.' },
  ],
};

// Seeded dev translator (see fluent-api/src/db/seeds/dev-users.ts and rbac.ts).
// The Translator role carries content:update, which AI_TOOLS_USE aliases, so
// this user can invoke the endpoint. Override with --signin-email/-password.
const DEFAULT_SIGNIN_EMAIL = 't@fluent.local';
const DEFAULT_SIGNIN_PASSWORD = 't@123456';

// BetterAuth rejects sign-in requests whose Origin isn't trusted
// (`MISSING_OR_NULL_ORIGIN` / 403). fluent-api's trustedOrigins is derived from
// FRONTEND_URL (see src/lib/auth.ts), which in the dev stack is the web app at
// http://localhost:5173. Browsers set Origin automatically; this script is not
// a browser, so it must send a matching Origin header by hand. Override with
// --origin or FLUENT_API_ORIGIN / FRONTEND_URL if your stack differs.
const DEFAULT_SIGNIN_ORIGIN = 'http://localhost:5173';

interface CliArgs {
  url: string;
  token?: string;
  cookie?: string;
  signinEmail: string;
  signinPassword: string;
  signinOrigin: string;
  timeoutMs: number;
  raw: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: (process.env.FLUENT_API_URL ?? 'http://localhost:9999').replace(/\/$/, ''),
    signinEmail: process.env.FLUENT_API_SIGNIN_EMAIL ?? DEFAULT_SIGNIN_EMAIL,
    signinPassword: process.env.FLUENT_API_SIGNIN_PASSWORD ?? DEFAULT_SIGNIN_PASSWORD,
    signinOrigin: (
      process.env.FLUENT_API_ORIGIN ??
      process.env.FRONTEND_URL ??
      DEFAULT_SIGNIN_ORIGIN
    ).replace(/\/$/, ''),
    timeoutMs: 30_000,
    raw: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--url':
        args.url = (argv[++i] ?? '').replace(/\/$/, '');
        break;
      case '--token':
        args.token = argv[++i];
        break;
      case '--cookie':
        args.cookie = argv[++i];
        break;
      case '--signin-email':
        args.signinEmail = argv[++i] ?? '';
        break;
      case '--signin-password':
        args.signinPassword = argv[++i] ?? '';
        break;
      case '--origin':
        args.signinOrigin = (argv[++i] ?? '').replace(/\/$/, '');
        break;
      case '--timeout':
        args.timeoutMs = Number(argv[++i]) * 1000;
        break;
      case '--raw':
        args.raw = true;
        break;
      case '-h':
      case '--help':
        console.error(
          'Usage: npm run smoke:repeated-words -- [--url <base>] [--token <bearer>] ' +
            '[--cookie <header>] [--signin-email <email>] [--signin-password <pw>] ' +
            '[--origin <url>] [--timeout <seconds>] [--raw]\n\n' +
            'With no --token/--cookie, the script auto-signs-in (default ' +
            `${DEFAULT_SIGNIN_EMAIL}) and uses the captured bearer token. The ` +
            `sign-in Origin header defaults to ${DEFAULT_SIGNIN_ORIGIN} (the dev ` +
            "web app), which must match fluent-api's trustedOrigins / FRONTEND_URL."
        );
        process.exit(2);
        break;
      default:
        console.error(`error: unknown argument: ${arg}`);
        process.exit(2);
    }
  }

  // A pre-supplied token (flag or env) takes precedence over auto sign-in.
  if (!args.token && process.env.FLUENT_API_TOKEN) {
    args.token = process.env.FLUENT_API_TOKEN;
  }

  return args;
}

/**
 * Print an actionable hint when sign-in is rejected because the dev user was
 * never seeded. A fresh `./fluent.sh up` only runs the roles + RBAC seeds
 * (via fluent-api/docker-entrypoint.sh); the organization and dev-user seeds
 * are deliberately left out of the automatic boot so production images never
 * auto-provision login accounts. The two seeds below create the default
 * "Fluent Dev" org and the dev users this script authenticates as.
 */
/**
 * Print an actionable hint when sign-in is rejected for a bad Origin
 * (MISSING_OR_NULL_ORIGIN). fluent-api's BetterAuth trustedOrigins is derived
 * from FRONTEND_URL (src/lib/auth.ts); a non-browser client must send a
 * matching Origin header by hand.
 */
function printOriginMismatchHint(origin: string): void {
  console.error('');
  console.error('────────────────────────────────────────────────────────────────────');
  console.error(`The sign-in Origin "${origin}" was rejected by BetterAuth.`);
  console.error('');
  console.error("fluent-api only trusts the origin derived from its FRONTEND_URL");
  console.error('(see src/lib/auth.ts → trustedOrigins). In the default dev stack');
  console.error('that is the web app at http://localhost:5173.');
  console.error('');
  console.error('Pass an Origin that matches your stack, e.g.:');
  console.error('    npm run smoke:repeated-words -- --origin http://localhost:5173');
  console.error('Or set FLUENT_API_ORIGIN / FRONTEND_URL in the environment.');
  console.error('Check the api container value with:');
  console.error('    docker compose exec api sh -c \'echo "$FRONTEND_URL"\'');
  console.error('────────────────────────────────────────────────────────────────────');
}

function printMissingDevUserHint(email: string): void {
  const isDefaultUser = email === DEFAULT_SIGNIN_EMAIL || email === 'pm@fluent.local';
  console.error('');
  console.error('────────────────────────────────────────────────────────────────────');
  console.error(`The account "${email}" could not sign in.`);
  if (isDefaultUser) {
    console.error('');
    console.error('A fresh `./fluent.sh up` seeds roles + RBAC but NOT the organization');
    console.error('or the dev users, so the default smoke-test account does not exist');
    console.error('yet. Seed them once (order matters — org before users):');
    console.error('');
    console.error('  Ecosystem mode (from fluent-platform/):');
    console.error('    docker compose exec api npx tsx src/db/seeds/organizations.ts');
    console.error('    docker compose exec api npx tsx src/db/seeds/dev-users.ts');
    console.error('');
    console.error('  Standalone / inside the api container (from fluent-api/):');
    console.error('    npm run db:seed:org');
    console.error('    npm run db:seed:dev-users');
    console.error('');
    console.error('That creates "Fluent Dev" plus pm@fluent.local / t@fluent.local.');
    console.error('Then re-run this smoke test.');
  } else {
    console.error('');
    console.error('Verify the credentials, or seed dev users with (from fluent-api/):');
    console.error('    npm run db:seed:org && npm run db:seed:dev-users');
    console.error('Override the SEED_* env vars if you use custom dev credentials');
    console.error('(see src/db/seeds/dev-users.ts).');
  }
  console.error('────────────────────────────────────────────────────────────────────');
}

/**
 * Sign in with email/password and return the BetterAuth bearer token, which
 * the server exposes via the `set-auth-token` response header (bearer plugin).
 * Returns null on any failure (caller renders a clear error).
 */
async function signIn(
  baseUrl: string,
  email: string,
  password: string,
  origin: string,
  timeoutMs: number
): Promise<string | null> {
  const endpoint = `${baseUrl}/api/auth/sign-in/email`;
  console.error(`Signing in as ${email} at ${endpoint} (Origin: ${origin}) ...`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Required: BetterAuth rejects sign-in with a missing/untrusted Origin
        // (MISSING_OR_NULL_ORIGIN). Must match fluent-api's trustedOrigins,
        // which is derived from FRONTEND_URL. See parseArgs / --origin.
        Origin: origin,
      },
      body: JSON.stringify({ email, password }),
      signal: controller.signal,
    });

    const token = response.headers.get('set-auth-token');
    if (!response.ok) {
      const body = await response.text();
      console.error(`error: sign-in failed (HTTP ${response.status}): ${body}`);
      // Two very different failures land here:
      //   * MISSING_OR_NULL_ORIGIN → the Origin header didn't match
      //     fluent-api's trustedOrigins (FRONTEND_URL). Tell the operator to
      //     fix --origin rather than reseed.
      //   * Otherwise a 401/403 almost always means the dev user simply hasn't
      //     been seeded yet: a fresh `./fluent.sh up` seeds roles + RBAC but
      //     intentionally NOT the org or the dev users (see
      //     src/db/seeds/organizations.ts + dev-users.ts), so the account this
      //     script signs in as does not exist. Point at the exact seeds.
      if (body.includes('MISSING_OR_NULL_ORIGIN') || body.includes('ORIGIN')) {
        printOriginMismatchHint(origin);
      } else if (response.status === 401 || response.status === 403) {
        printMissingDevUserHint(email);
      }
      return null;
    }
    if (!token) {
      console.error(
        'error: sign-in succeeded but no set-auth-token header was returned. ' +
          'Is the BetterAuth bearer() plugin enabled and the header exposed via CORS?'
      );
      return null;
    }
    console.error('Sign-in OK; captured bearer token.');
    return token;
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    console.error(
      isAbort
        ? `error: sign-in request to ${endpoint} timed out`
        : `error: could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface Finding {
  legitimate?: boolean;
  [key: string]: unknown;
}

interface SanityCheck {
  passed: boolean;
  label: string;
}

function runSanityChecks(payload: unknown): SanityCheck[] {
  const checks: SanityCheck[] = [];
  const record = (label: string, passed: boolean) => checks.push({ label, passed });

  if (typeof payload !== 'object' || payload === null) {
    record('response is a JSON object', false);
    return checks;
  }
  record('response is a JSON object', true);

  const envelope = payload as Record<string, unknown>;
  record('envelope.status == "completed"', envelope.status === 'completed');
  record(
    'envelope.tool == "greek_room.repeated_words"',
    envelope.tool === 'greek_room.repeated_words'
  );

  const result = envelope.result;
  if (typeof result !== 'object' || result === null) {
    record('envelope.result is a JSON object', false);
    return checks;
  }
  record('envelope.result is a JSON object', true);

  const resultObj = result as Record<string, unknown>;
  const findings = resultObj.findings;
  if (!Array.isArray(findings)) {
    record('result.findings is an array', false);
    return checks;
  }
  record('result.findings is an array', true);
  record('result.findings has exactly 2 entries', findings.length === 2);

  const typed = findings as Finding[];
  const legitimate = typed.filter((f) => f.legitimate === true);
  const suspicious = typed.filter((f) => f.legitimate === false);
  record('exactly one legitimate finding', legitimate.length === 1);
  record('exactly one suspicious finding', suspicious.length === 1);

  const summary = resultObj.summary;
  if (typeof summary === 'object' && summary !== null) {
    const summaryObj = summary as Record<string, unknown>;
    record('summary.verse_count == 3', summaryObj.verse_count === 3);
    record(
      'summary.total_findings == result.findings.length',
      summaryObj.total_findings === findings.length
    );
  } else {
    record('summary is a JSON object', false);
  }

  return checks;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const endpoint = `${args.url}/ai/tools/greek-room/repeated-words`;

  // Resolve a credential: explicit token/cookie wins; otherwise auto sign-in.
  if (!args.token && !args.cookie) {
    if (!args.signinEmail || !args.signinPassword) {
      console.error(
        'error: no credential and no sign-in email/password available. ' +
          'Pass --token/--cookie, or --signin-email/--signin-password.'
      );
      return 2;
    }
    const token = await signIn(
      args.url,
      args.signinEmail,
      args.signinPassword,
      args.signinOrigin,
      args.timeoutMs
    );
    if (!token) return 1;
    args.token = token;
    console.error('');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (args.token) headers.Authorization = `Bearer ${args.token}`;
  if (args.cookie) headers.Cookie = args.cookie;

  console.error(`POST ${endpoint}`);
  console.error(args.token ? 'Authorization: Bearer ...(redacted)' : 'Cookie: ...(redacted)');
  console.error('');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);

  let status: number;
  let rawBody: string;
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(SAMPLE_REQUEST),
      signal: controller.signal,
    });
    status = response.status;
    rawBody = await response.text();
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    console.error(
      isAbort
        ? `error: request to ${endpoint} timed out`
        : `error: could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)}`
    );
    return 1;
  } finally {
    clearTimeout(timer);
  }

  console.error(`HTTP ${status}`);
  console.error('');

  if (args.raw) {
    process.stdout.write(rawBody.endsWith('\n') ? rawBody : `${rawBody}\n`);
    return status === 200 ? 0 : 1;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error('error: response was not valid JSON; raw body follows:');
    console.error(rawBody);
    return 1;
  }

  console.log(JSON.stringify(payload, null, 2));

  if (status !== 200) {
    console.error(`\nerror: expected HTTP 200, got ${status}`);
    return 1;
  }

  console.error('');
  console.error('--- response shape sanity checks ---');
  const results = runSanityChecks(payload);
  let passedCount = 0;
  for (const { passed, label } of results) {
    console.error(`  ${passed ? 'ok  ' : 'FAIL'} ${label}`);
    if (passed) passedCount++;
  }
  const total = results.length;
  const failed = passedCount < total;

  // Unmissable final verdict banner, mirroring fluent-ai's self-grading smoke
  // script: a clear PASS/FAIL line with the check tally, set off by a rule so
  // it never blends into the JSON body printed above.
  console.error('');
  console.error('════════════════════════════════════════════════════════════════════');
  if (failed) {
    console.error(`  SMOKE TEST FAILED  —  ${passedCount}/${total} checks passed`);
    console.error('════════════════════════════════════════════════════════════════════');
    return 1;
  }
  console.error(`  SMOKE TEST PASSED  —  ${passedCount}/${total} checks passed`);
  console.error('════════════════════════════════════════════════════════════════════');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('unexpected error:', error);
    process.exit(1);
  });
