# QA demo seeding: committed password hashes and clean-slate resets

For the QA/dev environments we seed demo accounts with better-auth password **hashes committed to the repo** (`src/db/seeds/qa-demo/spec.ts`) rather than plaintext supplied via env vars, and `db:reset:*` performs a **full clean slate** (drop `public`/`drizzle`/`pgboss` schemas, re-migrate, re-seed) rather than reconciling into existing data.

**Why:** env-var passwords pushed plaintext into `.env` files, shell history, and Azure config — and still required manual `db:set-password` runs after any wipe. A committed hash satisfies "no plaintext in git" while making every seeded account work immediately after `db:setup`. Clean-slate resets keep QA deterministic: "reset" can never mean different things depending on what happens to be in the DB.

**Trade-off accepted:** a committed hash is effectively a committed credential for a network-reachable box, and enables offline brute-force. Accepted because these environments hold only fake/demo data and no production access. Consequences: the shared password must be unique and never reused anywhere real; the hash must never appear for a production account; anything created on QA outside the seeds is destroyed on every reset — testers must treat the environment as disposable. The `ai` schema is deliberately excluded from drops (owned by a different service's migrator).
