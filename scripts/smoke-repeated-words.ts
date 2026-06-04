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
 * Because the fluent-api endpoint is guarded by a BetterAuth session +
 * AI_TOOLS_USE permission, you must supply a session credential:
 *
 *   # Bearer token (mobile / API client):
 *   npm run smoke:repeated-words -- --token "<better-auth-bearer-token>"
 *
 *   # Or a raw Cookie header (web session):
 *   npm run smoke:repeated-words -- --cookie "better-auth.session_token=..."
 *
 *   # Override the base URL (default: $FLUENT_API_URL or http://localhost:9999):
 *   npm run smoke:repeated-words -- --url http://localhost:9999 --token "..."
 *
 *   # Print the raw response body and skip sanity checks:
 *   npm run smoke:repeated-words -- --raw --token "..."
 *
 * Exit status:
 *   0 — request succeeded and (unless --raw) all sanity checks passed
 *   1 — HTTP error, unexpected response shape, or failed sanity check
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

interface CliArgs {
  url: string;
  token?: string;
  cookie?: string;
  timeoutMs: number;
  raw: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: (process.env.FLUENT_API_URL ?? 'http://localhost:9999').replace(/\/$/, ''),
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
            '[--cookie <header>] [--timeout <seconds>] [--raw]'
        );
        process.exit(2);
        break;
      default:
        console.error(`error: unknown argument: ${arg}`);
        process.exit(2);
    }
  }

  if (!args.token && !args.cookie && !process.env.FLUENT_API_TOKEN) {
    console.error(
      'error: no session credential supplied. Pass --token <bearer> or --cookie <header> ' +
        '(or set FLUENT_API_TOKEN). The endpoint requires a BetterAuth session.'
    );
    process.exit(2);
  }
  if (!args.token && process.env.FLUENT_API_TOKEN) {
    args.token = process.env.FLUENT_API_TOKEN;
  }

  return args;
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
  let failed = false;
  for (const { passed, label } of results) {
    console.error(`  ${passed ? 'ok  ' : 'FAIL'} ${label}`);
    if (!passed) failed = true;
  }

  console.error('');
  if (failed) {
    console.error('one or more sanity checks failed');
    return 1;
  }
  console.error('smoke test passed');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('unexpected error:', error);
    process.exit(1);
  });
