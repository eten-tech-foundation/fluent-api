# AGENTS.md — Fluent API

Fluent's backend, Hono and Drizzle on Postgres. It is the only backend for
[fluent-web](https://github.com/eten-tech-foundation/fluent-web) and calls
[fluent-ai](https://github.com/eten-tech-foundation/fluent-ai) over HTTP.

## Read only what the task needs

- Finding where a domain or endpoint lives, or what it calls: [docs/code-map.md](docs/code-map.md).
- Changing permissions, scripture text, saving, async jobs, content protection or feature flags:
  [docs/domain-rules.md](docs/domain-rules.md).
- Writing code in `src/`: the [Code standards](#code-standards) below, and
  [ARCHITECTURE.md](ARCHITECTURE.md) for how a domain module is shaped.
- Roles, grants and the auth middleware chain in detail: [docs/permissions.md](docs/permissions.md).
- Setup, migrations and the database: [CONTRIBUTING.md](CONTRIBUTING.md) and
  [docs/db-provisioning-and-setup.md](docs/db-provisioning-and-setup.md).

Never edit or rename a migration in `src/db/migrations/`. Generate a new one with
`npm run db:generate <name>`.

## Docs

See `docs/README.md` for the docs directory convention. Brainstorming and
writing-plans skill output goes to `docs/features/<slug>/`
(`proposal.md`/`design.md`/`plan.md`/`tickets/`), not the skill's built-in
`docs/superpowers/...` default.

## Code standards

Rules with IDs (`FA-L*` lint, `FA-C*` CI, `FA-R*` review) are in
`docs/guides/code-standards.md`. Read it before writing code in `src/`. Before opening a PR
or marking one ready, follow `.claude/skills/pre-pr-standards/SKILL.md`: `npm run verify`,
then a verdict for every `FA-R` rule.

## Agent skills

### Issue tracker

Issues are tracked as GitHub issues in this repo (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
